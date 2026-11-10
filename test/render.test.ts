import { describe, expect, it } from 'vitest';
import {
  buildButtons,
  buildJobViews,
  escapeHtml,
  formatDuration,
  isServiceStep,
  jobFailure,
  renderFailureReply,
  renderMessage,
  stepMark,
  summarize,
  TEXT_LIMIT,
  truncateLines,
} from '../src/render.js';
import type { ApiJob, ApiStep, Meta } from '../src/types.js';

let n = 0;
const step = (name: string, status = 'completed', conclusion: string | null = 'success'): ApiStep => ({
  name,
  status,
  conclusion,
  number: ++n,
});

const job = (name: string, steps: ApiStep[], over: Partial<ApiJob> = {}): ApiJob => ({
  id: over.id ?? 1,
  name,
  status: 'in_progress',
  conclusion: null,
  started_at: '2026-11-10T10:00:00Z',
  completed_at: null,
  html_url: `https://github.com/o/r/actions/runs/1/job/${over.id ?? 1}`,
  runner_name: 'GitHub Actions 1',
  steps,
  ...over,
});

const meta: Meta = { repo: 'qu1nqqy/rustos', branch: 'master', authors: ['alice', 'bob'] };

describe('escapeHtml', () => {
  it('экранирует &, <, >', () => {
    expect(escapeHtml('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d');
  });
  it('не трогает кавычки и юникод', () => {
    expect(escapeHtml('"шаг" \'1\' ✅')).toBe('"шаг" \'1\' ✅');
  });
});

describe('isServiceStep', () => {
  it.each(['Set up job', 'Complete job', 'Post Run actions/checkout@v4', 'Post Checkout', 'Run qu1nqqy/tg-notify@v1', 'Initialize containers'])(
    'скрывает «%s»',
    (name) => expect(isServiceStep(name)).toBe(true),
  );
  it.each(['Run actions/checkout@v4', 'cargo clippy', 'Tests in QEMU', 'Postgres setup'])('показывает «%s»', (name) =>
    expect(isServiceStep(name)).toBe(false),
  );
  it('скрывает шаг с произвольным именем из списка', () => {
    expect(isServiceStep('Telegram', ['Telegram'])).toBe(true);
  });
});

describe('stepMark', () => {
  it('только три значка', () => {
    expect(stepMark({ status: 'queued', conclusion: null })).toBe('⏳');
    expect(stepMark({ status: 'in_progress', conclusion: null })).toBe('⏳');
    expect(stepMark({ status: 'completed', conclusion: 'success' })).toBe('✅');
    expect(stepMark({ status: 'completed', conclusion: 'failure' })).toBe('❌');
    expect(stepMark({ status: 'completed', conclusion: 'cancelled' })).toBe('❌');
    expect(stepMark({ status: 'completed', conclusion: 'skipped' })).toBeNull();
  });
});

describe('buildJobViews', () => {
  it('убирает служебные и пропущенные шаги', () => {
    const views = buildJobViews([
      job('test', [
        step('Set up job'),
        step('Run qu1nqqy/tg-notify@v1'),
        step('Run actions/checkout@v4'),
        step('fmt', 'in_progress', null),
        step('clippy', 'queued', null),
        step('optional', 'completed', 'skipped'),
        step('Post Run actions/checkout@v4', 'queued', null),
        step('Complete job', 'queued', null),
      ]),
    ]);
    expect(views[0]!.steps).toEqual([
      { name: 'Run actions/checkout@v4', mark: '✅' },
      { name: 'fmt', mark: '⏳' },
      { name: 'clippy', mark: '⏳' },
    ]);
  });

  it('пропущенную задачу не показывает', () => {
    const views = buildJobViews([job('release', [], { id: 2, status: 'completed', conclusion: 'skipped' })]);
    expect(views).toEqual([]);
  });

  it('в post текущая задача считается завершённой по шагам', () => {
    const j = job('test', [step('a'), step('b', 'completed', 'failure'), step('Post x', 'in_progress', null)], { id: 7 });
    const [v] = buildJobViews([j], { currentJobId: 7, final: true });
    expect(v!.mark).toBe('❌');
  });
});

describe('summarize', () => {
  const now = Date.parse('2026-11-10T10:04:12Z');

  it('идёт, пока есть незавершённые задачи', () => {
    expect(summarize([job('test', [step('a')])], {}, now).state).toBe('running');
  });

  it('успех и длительность от начала первой задачи', () => {
    const jobs = [job('test', [step('a')], { id: 1, status: 'completed', conclusion: 'success' }), job('release', [step('b')], { id: 2, started_at: '2026-11-10T10:02:00Z' })];
    const s = summarize(jobs, { currentJobId: 2, final: true }, now);
    expect(s.state).toBe('success');
    expect(s.durationSec).toBe(252);
    expect(formatDuration(s.durationSec!)).toBe('4:12');
  });

  it('провал: шаг и ссылка на шаг', () => {
    const failing = step('clippy', 'completed', 'failure');
    const s = summarize([job('test', [step('fmt'), failing, step('tests', 'completed', 'skipped')], { id: 5 })], {
      currentJobId: 5,
      final: true,
    }, now);
    expect(s).toMatchObject({
      state: 'failure',
      failedJob: 'test',
      failedStep: 'clippy',
      failedUrl: `https://github.com/o/r/actions/runs/1/job/5#step:${failing.number}:1`,
    });
  });

  it('отмена', () => {
    const s = summarize([job('test', [step('a', 'completed', 'cancelled')], { id: 3 })], { currentJobId: 3, final: true }, now);
    expect(s.state).toBe('cancelled');
  });

  it('пропущенная задача не мешает успеху', () => {
    const jobs = [
      job('test', [step('a')], { id: 1, status: 'completed', conclusion: 'success' }),
      job('release', [], { id: 2, status: 'completed', conclusion: 'skipped' }),
    ];
    expect(summarize(jobs, {}, now).state).toBe('success');
  });

  it('jobFailure: без шага — ссылка на задачу', () => {
    const f = jobFailure(job('build', [], { id: 9, status: 'completed', conclusion: 'failure' }));
    expect(f).toMatchObject({ failedJob: 'build', failedStep: undefined, failedUrl: 'https://github.com/o/r/actions/runs/1/job/9' });
  });
});

describe('renderMessage', () => {
  it('шаблон во время сборки, с ожидающей задачей', () => {
    const jobs = [
      job('test', [step('Set up job'), step('fmt'), step('clippy', 'in_progress', null)], { id: 1 }),
      job('release', [], { id: 2, status: 'queued' }),
    ];
    const text = renderMessage(meta, buildJobViews(jobs), summarize(jobs));
    expect(text).toBe(
      [
        '⏳ Запущена сборка…',
        '• Репозиторий: qu1nqqy/rustos',
        '• Ветка: master',
        '• Автор: alice, bob',
        '',
        '📝 <b>test</b>',
        '✅ fmt',
        '⏳ clippy',
        '',
        '📝 <b>release</b> ⏳',
      ].join('\n'),
    );
  });

  it('итог при успехе и провале', () => {
    const ok = renderMessage(meta, [], { state: 'success', durationSec: 252 });
    expect(ok.startsWith('✅ Сборка прошла')).toBe(true);
    expect(ok.endsWith('✅ Готово за 4:12')).toBe(true);

    const bad = renderMessage(meta, [], { state: 'failure', failedStep: 'cargo <clippy>' });
    expect(bad.startsWith('❌ Сборка упала')).toBe(true);
    expect(bad.endsWith('❌ Упало: cargo &lt;clippy&gt;')).toBe(true);
  });

  it('экранирует имена задач, шагов и шапку', () => {
    const text = renderMessage({ repo: 'o/r', branch: 'feat/<x>', authors: ['a&b'] }, buildJobViews([job('a<b>', [step('x & y')])]), {
      state: 'running',
    });
    expect(text).toContain('feat/&lt;x&gt;');
    expect(text).toContain('a&amp;b');
    expect(text).toContain('<b>a&lt;b&gt;</b>');
    expect(text).toContain('✅ x &amp; y');
  });

  it('сокращается до 4096 и сохраняет итог', () => {
    const many = Array.from({ length: 400 }, (_, i) => step(`очень длинное имя шага номер ${i} `.repeat(2)));
    const failing = step('упавший шаг', 'completed', 'failure');
    const jobs = [
      job('build', many, { id: 1, status: 'completed', conclusion: 'success' }),
      job('test', [...many, failing], { id: 2 }),
    ];
    const summary = summarize(jobs, { currentJobId: 2, final: true });
    const text = renderMessage(meta, buildJobViews(jobs, { currentJobId: 2, final: true }), summary);
    expect(text.length).toBeLessThanOrEqual(TEXT_LIMIT);
    expect(text).toContain('📝 <b>build</b> ✅ (шагов: 400)');
    expect(text).toContain('❌ упавший шаг');
    expect(text.endsWith('❌ Упало: упавший шаг')).toBe(true);
  });

  it('жёсткая обрезка по строкам, если не помогло', () => {
    const jobs = Array.from({ length: 300 }, (_, i) => job(`job ${i}`, [step('x', 'in_progress', null)], { id: i + 1 }));
    const text = renderMessage(meta, buildJobViews(jobs), { state: 'running' });
    expect(text.length).toBeLessThanOrEqual(TEXT_LIMIT);
    expect(text.endsWith('\n…')).toBe(true);
  });
});

describe('truncateLines', () => {
  it('режет по границе строки', () => {
    expect(truncateLines('aaa\nbbb\nccc', 9)).toBe('aaa\nbbb\n…');
    expect(truncateLines('aaa\nbbb\nccc', 8)).toBe('aaa\n…');
    expect(truncateLines('short', 10)).toBe('short');
  });
});

describe('buildButtons', () => {
  const runUrl = 'https://github.com/o/r/actions/runs/1';
  const commitUrl = 'https://github.com/o/r/commit/abc';

  it('push: запуск и коммит', () => {
    expect(buildButtons({ runUrl, commitUrl })).toEqual([
      [
        { text: 'Запуск', url: runUrl },
        { text: 'Коммит', url: commitUrl },
      ],
    ]);
  });

  it('pull_request: добавляется PR', () => {
    const rows = buildButtons({ runUrl, commitUrl, prUrl: 'https://github.com/o/r/pull/3' });
    expect(rows.flat().map((b) => b.text)).toEqual(['Запуск', 'Коммит', 'PR']);
  });

  it('с релизом', () => {
    const rows = buildButtons({ runUrl, commitUrl, releaseUrl: 'https://github.com/o/r/releases/tag/v1' });
    expect(rows.flat().map((b) => b.text)).toEqual(['Запуск', 'Коммит', 'Релиз']);
  });
});

describe('renderFailureReply', () => {
  it('репозиторий и шаг', () => {
    expect(renderFailureReply('o/r', { state: 'failure', failedJob: 'test', failedStep: 'clippy' })).toBe('❌ o/r: упало на clippy');
    expect(renderFailureReply('o/r', { state: 'failure', failedJob: 'test' })).toBe('❌ o/r: упало на test');
  });
});
