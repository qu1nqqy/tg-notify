import type { ApiJob, ApiStep, Button, JobView, Links, Mark, Meta, StepView, Summary } from './types.js';

/** Лимит текста сообщения в Telegram. */
export const TEXT_LIMIT = 4096;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SERVICE_STEPS = [
  /^set up job$/i,
  /^complete job$/i,
  /^post\s/i,
  /^(initialize|stop) containers$/i,
  /tg-notify/i,
];

/** Служебный шаг, который не показываем: Set up job, Complete job, Post ..., сам tg-notify. */
export function isServiceStep(name: string, hidden: readonly string[] = []): boolean {
  const n = name.trim();
  return SERVICE_STEPS.some((re) => re.test(n)) || hidden.includes(n);
}

const BAD = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required']);

/** Значок шага; null — шаг не показываем (пропущен). */
export function stepMark(step: Pick<ApiStep, 'status' | 'conclusion'>): Mark | null {
  if (step.status !== 'completed') return '⏳';
  if (step.conclusion === 'skipped') return null;
  if (step.conclusion && BAD.has(step.conclusion)) return '❌';
  return '✅';
}

export interface ViewOptions {
  /** id задачи, в которой работает action. */
  currentJobId?: number;
  /** post-хук: текущая задача считается завершённой, её итог считается по шагам. */
  final?: boolean;
  /** Дополнительные имена шагов, которые нужно скрыть. */
  hiddenSteps?: readonly string[];
}

function visibleSteps(job: ApiJob, hidden: readonly string[]): ApiStep[] {
  return (job.steps ?? []).filter((s) => !isServiceStep(s.name, hidden));
}

/** Итог задачи: completed + conclusion, а для текущей задачи в post — по её шагам. */
function jobConclusion(job: ApiJob, opts: ViewOptions): { done: boolean; conclusion: string | null } {
  if (opts.final && job.id === opts.currentJobId) {
    const steps = job.steps ?? [];
    if (steps.some((s) => s.conclusion === 'cancelled')) return { done: true, conclusion: 'cancelled' };
    if (steps.some((s) => s.conclusion && BAD.has(s.conclusion))) return { done: true, conclusion: 'failure' };
    return { done: true, conclusion: 'success' };
  }
  return { done: job.status === 'completed', conclusion: job.conclusion };
}

/** Задачи для показа: без пропущенных, шаги без служебных и пропущенных. */
export function buildJobViews(jobs: readonly ApiJob[], opts: ViewOptions = {}): JobView[] {
  const hidden = opts.hiddenSteps ?? [];
  const views: JobView[] = [];
  for (const job of jobs) {
    const { done, conclusion } = jobConclusion(job, opts);
    if (done && conclusion === 'skipped') continue;
    const steps: StepView[] = [];
    for (const s of visibleSteps(job, hidden)) {
      const mark = stepMark(s);
      if (mark) steps.push({ name: s.name, mark });
    }
    const mark: Mark = !done ? '⏳' : conclusion && BAD.has(conclusion) ? '❌' : '✅';
    views.push({ id: job.id, name: job.name, mark, steps });
  }
  return views;
}

/** Провал задачи: упавший шаг и ссылка на него. undefined — задача не упала (или ещё идёт). */
export function jobFailure(job: ApiJob, opts: ViewOptions = {}): Omit<Summary, 'state' | 'durationSec'> | undefined {
  const { done, conclusion } = jobConclusion(job, opts);
  if (!done || !conclusion || !BAD.has(conclusion) || conclusion === 'cancelled') return undefined;
  const step = visibleSteps(job, opts.hiddenSteps ?? []).find((s) => s.conclusion && BAD.has(s.conclusion));
  return {
    failedJob: job.name,
    failedJobId: job.id,
    failedStep: step?.name,
    failedUrl: job.html_url ? (step ? `${job.html_url}#step:${step.number}:1` : job.html_url) : undefined,
  };
}

/** Общий итог запуска по всем задачам. */
export function summarize(jobs: readonly ApiJob[], opts: ViewOptions = {}, now = Date.now()): Summary {
  let running = false;
  let cancelled = false;
  let failed: Omit<Summary, 'state'> | undefined;
  for (const job of jobs) {
    const { done, conclusion } = jobConclusion(job, opts);
    if (!done) {
      running = true;
      continue;
    }
    if (conclusion === 'cancelled') cancelled = true;
    failed ??= jobFailure(job, opts);
  }
  if (running) return { state: 'running' };
  const starts = jobs.map((j) => (j.started_at ? Date.parse(j.started_at) : NaN)).filter((t) => !Number.isNaN(t));
  const durationSec = starts.length ? Math.max(0, Math.round((now - Math.min(...starts)) / 1000)) : undefined;
  if (failed) return { state: 'failure', ...failed, durationSec };
  if (cancelled) return { state: 'cancelled', durationSec };
  return { state: 'success', durationSec };
}

export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Заголовок по умолчанию; меняется входом title. */
export const DEFAULT_TITLE = 'Сборка';

const STATE_WORDS: Record<Summary['state'], [string, string]> = {
  running: ['⏳', 'выполняется'],
  success: ['✅', 'успешно'],
  failure: ['❌', 'ошибка'],
  cancelled: ['❌', 'отменено'],
};

/** «✅ Сборка: успешно» — без согласования по роду, чтобы подходил любой title. */
export function headerLine(title: string, state: Summary['state']): string {
  const [icon, word] = STATE_WORDS[state];
  return `<b>${icon} ${escapeHtml(title || DEFAULT_TITLE)}: ${word}</b>`;
}

function footer(summary: Summary): string | null {
  switch (summary.state) {
    case 'running':
      return null;
    case 'success':
      return summary.durationSec === undefined
        ? '<b>✅ Готово</b>'
        : `<b>✅ Готово за ${formatDuration(summary.durationSec)}</b>`;
    case 'cancelled':
      return '<b>❌ Отменено</b>';
    case 'failure': {
      const where = summary.failedStep ?? summary.failedJob ?? 'неизвестный шаг';
      return `<b>❌ Упало:</b> <code>${escapeHtml(displayStep(where))}</code>`;
    }
  }
}

/** Уровни сокращения, если текст не помещается в лимит. */
export enum Compact {
  Full = 0,
  /** Успешно завершённые задачи свёрнуты в одну строку. */
  CollapseDone = 1,
  /** Скрыты все успешные шаги, вместо них счётчик. */
  HideSuccess = 2,
  /** Имена шагов обрезаны. */
  ShortNames = 3,
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** «Run npm test» → «npm test»: префикс GitHub по умолчанию только шумит. */
export function displayStep(name: string): string {
  return name.replace(/^Run\s+/, '');
}

/**
 * Секция задачи: заголовок жирным, шаги в цитате. Завершённая успешная задача — в
 * сворачиваемой цитате, чтобы не занимать место. plain — без цитат (для жёсткой обрезки
 * по строкам, где многострочный тег нельзя разрывать).
 */
function renderJob(job: JobView, level: Compact, plain = false): string {
  const title = `📝 <b>${escapeHtml(level >= Compact.ShortNames ? clip(job.name, 60) : job.name)}</b>`;
  if (job.steps.length === 0) return `${title} ${job.mark}`;
  if (level >= Compact.CollapseDone && job.mark === '✅') return `${title} ✅ <i>(шагов: ${job.steps.length})</i>`;
  const lines: string[] = [];
  let okHidden = 0;
  for (const s of job.steps) {
    if (level >= Compact.HideSuccess && s.mark === '✅') {
      okHidden++;
      continue;
    }
    const name = displayStep(s.name);
    lines.push(`${s.mark} ${escapeHtml(level >= Compact.ShortNames ? clip(name, 40) : name)}`);
  }
  if (okHidden) lines.unshift(`✅ <i>успешных шагов: ${okHidden}</i>`);
  if (plain) return [title, ...lines].join('\n');
  const open = job.mark === '✅' && lines.length > 3 ? '<blockquote expandable>' : '<blockquote>';
  return `${title}\n${open}${lines.join('\n')}</blockquote>`;
}

function renderAt(
  meta: Meta,
  jobs: readonly JobView[],
  summary: Summary,
  level: Compact,
  opts: { footer?: boolean; plain?: boolean } = {},
): string {
  const code = (v: string) => `<code>${escapeHtml(v)}</code>`;
  const parts: string[] = [
    [
      headerLine(meta.title ?? DEFAULT_TITLE, summary.state),
      `• Репозиторий: ${code(meta.repo)}`,
      `• Ветка: ${code(meta.branch)}`,
      `• Автор: ${meta.authors.length ? meta.authors.map(code).join(', ') : '—'}`,
    ].join('\n'),
  ];
  for (const job of jobs) parts.push(renderJob(job, level, opts.plain));
  const end = opts.footer === false ? null : footer(summary);
  if (end) parts.push(end);
  return parts.join('\n\n');
}

/** Обрезает по границе строки, чтобы не разорвать HTML-тег. */
export function truncateLines(text: string, limit = TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  const tail = '\n…';
  const lines = text.split('\n');
  let out = '';
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length + tail.length > limit) break;
    out = next;
  }
  return out + tail;
}

/**
 * Текст сообщения. Если не помещается в 4096 символов, сокращается по уровням,
 * при этом итоговая строка (упало/готово) сохраняется.
 */
export function renderMessage(meta: Meta, jobs: readonly JobView[], summary: Summary, limit = TEXT_LIMIT): string {
  for (const level of [Compact.Full, Compact.CollapseDone, Compact.HideSuccess, Compact.ShortNames]) {
    const text = renderAt(meta, jobs, summary, level);
    if (text.length <= limit) return text;
  }
  const end = footer(summary);
  const body = renderAt(meta, jobs, summary, Compact.ShortNames, { footer: false, plain: true });
  if (!end) return truncateLines(body, limit);
  return `${truncateLines(body, limit - end.length - 2)}\n\n${end}`;
}

/** Inline-кнопки под сообщением о pipeline. */
export function buildButtons(links: Links): Button[][] {
  const row: Button[] = [{ text: 'Запуск', url: links.runUrl }, { text: 'Коммит', url: links.commitUrl }];
  if (links.prUrl) row.push({ text: 'PR', url: links.prUrl });
  if (links.releaseUrl) row.push({ text: 'Релиз', url: links.releaseUrl });
  // По две кнопки в ряд, чтобы подписи не обрезались на телефоне.
  const rows: Button[][] = [];
  for (let i = 0; i < row.length; i += 2) rows.push(row.slice(i, i + 2));
  return rows;
}

/** Текст отдельного ответа со звуком при провале. */
export function renderFailureReply(repo: string, summary: Summary): string {
  const where = summary.failedStep ?? summary.failedJob ?? 'неизвестный шаг';
  return `❌ <code>${escapeHtml(repo)}</code>: упало на <b>${escapeHtml(displayStep(where))}</b>`;
}
