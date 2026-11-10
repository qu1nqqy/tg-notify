import { readFileSync } from 'node:fs';
import type { Links, Meta } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type EventPayload = Record<string, any>;

export interface RunContext {
  serverUrl: string;
  apiUrl: string;
  repo: string; // owner/repo
  runId: string;
  runAttempt: string;
  eventName: string;
  sha: string;
  ref: string;
  refName: string;
  headRef: string;
  actor: string;
  runnerName: string;
  workflow: string;
  event: EventPayload;
}

export function readContext(env: NodeJS.ProcessEnv = process.env): RunContext {
  let event: EventPayload = {};
  if (env.GITHUB_EVENT_PATH) {
    try {
      event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    } catch {
      event = {};
    }
  }
  return {
    serverUrl: env.GITHUB_SERVER_URL ?? 'https://github.com',
    apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
    repo: env.GITHUB_REPOSITORY ?? '',
    runId: env.GITHUB_RUN_ID ?? '',
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? '1',
    eventName: env.GITHUB_EVENT_NAME ?? '',
    sha: env.GITHUB_SHA ?? '',
    ref: env.GITHUB_REF ?? '',
    refName: env.GITHUB_REF_NAME ?? '',
    headRef: env.GITHUB_HEAD_REF ?? '',
    actor: env.GITHUB_ACTOR ?? '',
    runnerName: env.RUNNER_NAME ?? '',
    workflow: env.GITHUB_WORKFLOW ?? '',
    event,
  };
}

export function isPullRequest(eventName: string): boolean {
  return eventName === 'pull_request' || eventName === 'pull_request_target';
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}

/**
 * Авторы: при push — уникальные авторы коммитов, при pull_request — автор PR,
 * в остальных случаях — github.actor.
 */
export function resolveAuthors(eventName: string, event: EventPayload, actor: string): string[] {
  if (eventName === 'push' && Array.isArray(event.commits) && event.commits.length > 0) {
    const names = uniq(
      event.commits.map((c: any) => String(c?.author?.username || c?.author?.name || c?.committer?.name || '')),
    );
    if (names.length) return names;
  }
  if (isPullRequest(eventName)) {
    const login = event.pull_request?.user?.login;
    if (login) return [String(login)];
  }
  return actor ? [actor] : [];
}

export function resolveBranch(ctx: Pick<RunContext, 'eventName' | 'headRef' | 'refName' | 'ref'>): string {
  if (isPullRequest(ctx.eventName) && ctx.headRef) return ctx.headRef;
  return ctx.refName || ctx.ref.replace(/^refs\/(heads|tags)\//, '');
}

/** Коммит, который собирается: для PR — head-коммит, а не merge-коммит. */
export function resolveSha(ctx: Pick<RunContext, 'eventName' | 'event' | 'sha'>): string {
  if (isPullRequest(ctx.eventName)) return String(ctx.event.pull_request?.head?.sha ?? ctx.sha);
  return ctx.sha;
}

/** Заголовок из входа title; {workflow} заменяется именем workflow. */
export function resolveTitle(template: string | undefined, workflow: string): string | undefined {
  const t = template?.trim();
  if (!t) return undefined;
  return t.replace(/\{workflow\}/g, workflow).trim() || undefined;
}

export function resolveMeta(ctx: RunContext, title?: string): Meta {
  return {
    title: resolveTitle(title, ctx.workflow),
    repo: ctx.repo,
    branch: resolveBranch(ctx),
    authors: resolveAuthors(ctx.eventName, ctx.event, ctx.actor),
  };
}

export function resolveLinks(ctx: RunContext, releaseUrl?: string): Links {
  const base = `${ctx.serverUrl}/${ctx.repo}`;
  const prUrl = isPullRequest(ctx.eventName) ? ctx.event.pull_request?.html_url : undefined;
  return {
    runUrl: `${base}/actions/runs/${ctx.runId}${ctx.runAttempt && ctx.runAttempt !== '1' ? `/attempts/${ctx.runAttempt}` : ''}`,
    commitUrl: `${base}/commit/${resolveSha(ctx)}`,
    prUrl: prUrl ? String(prUrl) : undefined,
    releaseUrl,
  };
}
