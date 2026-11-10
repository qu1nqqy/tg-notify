import { describe, expect, it } from 'vitest';
import { resolveAuthors, resolveBranch, resolveLinks, resolveTitle, type RunContext } from '../src/context.js';
import { pickRelease, type Release } from '../src/github.js';
import { findCurrentJob, ownStepName } from '../src/pipeline.js';
import type { ApiJob } from '../src/types.js';

describe('resolveAuthors', () => {
  it('push: уникальные авторы коммитов', () => {
    const event = {
      commits: [
        { author: { username: 'alice', name: 'Alice' } },
        { author: { username: 'bob', name: 'Bob' } },
        { author: { username: 'alice', name: 'Alice' } },
        { author: { name: 'No Login' } },
      ],
    };
    expect(resolveAuthors('push', event, 'actor')).toEqual(['alice', 'bob', 'No Login']);
  });

  it('push без коммитов (тег) — actor', () => {
    expect(resolveAuthors('push', { commits: [] }, 'actor')).toEqual(['actor']);
  });

  it('pull_request — автор PR, а не тот, кто запустил', () => {
    expect(resolveAuthors('pull_request', { pull_request: { user: { login: 'carol' } } }, 'dependabot')).toEqual(['carol']);
    expect(resolveAuthors('pull_request_target', { pull_request: { user: { login: 'carol' } } }, 'x')).toEqual(['carol']);
  });

  it('остальные события — actor', () => {
    expect(resolveAuthors('workflow_dispatch', {}, 'dave')).toEqual(['dave']);
    expect(resolveAuthors('schedule', {}, '')).toEqual([]);
  });
});

describe('resolveBranch', () => {
  it('PR — head-ветка', () => {
    expect(resolveBranch({ eventName: 'pull_request', headRef: 'feat/x', refName: '3/merge', ref: 'refs/pull/3/merge' })).toBe('feat/x');
  });
  it('push — ref name', () => {
    expect(resolveBranch({ eventName: 'push', headRef: '', refName: 'master', ref: 'refs/heads/master' })).toBe('master');
  });
});

const ctx = (over: Partial<RunContext>): RunContext => ({
  serverUrl: 'https://github.com',
  apiUrl: 'https://api.github.com',
  repo: 'o/r',
  runId: '42',
  runAttempt: '1',
  eventName: 'push',
  sha: 'merge',
  ref: 'refs/heads/master',
  refName: 'master',
  headRef: '',
  actor: 'a',
  runnerName: 'r',
  workflow: 'build',
  event: {},
  ...over,
});

describe('resolveLinks', () => {
  it('push', () => {
    expect(resolveLinks(ctx({ sha: 'abc' }))).toEqual({
      runUrl: 'https://github.com/o/r/actions/runs/42',
      commitUrl: 'https://github.com/o/r/commit/abc',
      prUrl: undefined,
      releaseUrl: undefined,
    });
  });
  it('PR: head-коммит, ссылка на PR, повторная попытка', () => {
    const l = resolveLinks(
      ctx({
        eventName: 'pull_request',
        runAttempt: '2',
        event: { pull_request: { html_url: 'https://github.com/o/r/pull/3', head: { sha: 'head' } } },
      }),
    );
    expect(l.runUrl).toBe('https://github.com/o/r/actions/runs/42/attempts/2');
    expect(l.commitUrl).toBe('https://github.com/o/r/commit/head');
    expect(l.prUrl).toBe('https://github.com/o/r/pull/3');
  });
});

describe('pickRelease', () => {
  const rel = (tag: string, published_at: string | null, draft = false): Release => ({
    html_url: `https://github.com/o/r/releases/tag/${tag}`,
    tag_name: tag,
    name: tag,
    body: '',
    created_at: '2020-01-01T00:00:00Z',
    published_at,
    target_commitish: 'master',
    draft,
  });
  const list = [rel('v1', '2026-11-01T00:00:00Z'), rel('v2', '2026-11-10T10:05:00Z'), rel('v3', null, true)];

  it('по тегу', () => expect(pickRelease(list, { tag: 'v1' })?.tag_name).toBe('v1'));
  it('опубликованный после начала запуска', () =>
    expect(pickRelease(list, { since: '2026-11-10T10:00:00Z' })?.tag_name).toBe('v2'));
  it('нет нового — ничего', () => expect(pickRelease(list, { since: '2026-11-11T00:00:00Z' })).toBeUndefined());
});

describe('findCurrentJob', () => {
  const j = (id: number, runner: string | null, status: string): ApiJob => ({
    id,
    name: `j${id}`,
    status,
    conclusion: null,
    started_at: null,
    completed_at: null,
    html_url: null,
    runner_name: runner,
  });
  const jobs = [j(1, 'GitHub Actions 1', 'completed'), j(2, 'GitHub Actions 1', 'in_progress'), j(3, 'GitHub Actions 2', 'in_progress')];

  it('по раннеру', () => expect(findCurrentJob(jobs, 'GitHub Actions 1')?.id).toBe(2));
  it('по сохранённому id', () => expect(findCurrentJob(jobs, 'x', 1)?.id).toBe(1));
  it('не нашли', () => expect(findCurrentJob(jobs, '')).toBeUndefined());
});

describe('ownStepName', () => {
  const withSteps = (steps: [string, string][]): ApiJob => ({
    id: 1, name: 'j', status: 'in_progress', conclusion: null, started_at: null, completed_at: null, html_url: null, runner_name: 'r',
    steps: steps.map(([name, status], i) => ({ name, status, conclusion: null, number: i + 1 })),
  });
  it('выполняющийся шаг', () => expect(ownStepName(withSteps([['Set up job', 'completed'], ['Run ./', 'in_progress']]))).toBe('Run ./'));
  it('API ещё не догнал: «Set up job» не считается своим', () =>
    expect(ownStepName(withSteps([['Set up job', 'in_progress'], ['Run ./', 'queued']]))).toBeUndefined());
});

describe('resolveTitle', () => {
  it('пусто — по умолчанию', () => expect(resolveTitle('  ', 'ci')).toBeUndefined());
  it('свой', () => expect(resolveTitle('Проверка', 'ci')).toBe('Проверка'));
  it('{workflow}', () => expect(resolveTitle('{workflow}', 'build')).toBe('build'));
});
