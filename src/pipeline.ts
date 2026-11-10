import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '@actions/core';
import { readContext, resolveLinks, resolveMeta, type RunContext } from './context.js';
import { GitHub, pickRelease } from './github.js';
import {
  buildButtons,
  buildJobViews,
  jobFailure,
  renderFailureReply,
  renderMessage,
  summarize,
  type ViewOptions,
} from './render.js';
import { Telegram, TelegramError } from './telegram.js';
import type { ApiJob, Button, Summary } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Настройки, общие для main, фонового процесса и post. */
export interface PipelineConfig {
  token: string;
  chatId: string;
  threadId?: number;
  githubToken: string;
  messageId: number;
  currentJobId?: number;
  hiddenSteps: string[];
  pollIntervalMs: number;
}

export const POLLER_ENV = 'TG_NOTIFY_POLLER';

function telegram(cfg: Pick<PipelineConfig, 'token' | 'chatId' | 'threadId'>, log?: (m: string) => void): Telegram {
  return new Telegram({ token: cfg.token, chatId: cfg.chatId, threadId: cfg.threadId, log });
}

function github(cfg: Pick<PipelineConfig, 'githubToken'>, ctx: RunContext): GitHub {
  return new GitHub(cfg.githubToken, ctx.apiUrl, ctx.repo);
}

/** Задача, в которой мы работаем: та, что сейчас выполняется на нашем раннере. */
export function findCurrentJob(jobs: readonly ApiJob[], runnerName: string, knownId?: number): ApiJob | undefined {
  if (knownId) {
    const byId = jobs.find((j) => j.id === knownId);
    if (byId) return byId;
  }
  if (!runnerName) return undefined;
  return jobs.filter((j) => j.runner_name === runnerName && j.status === 'in_progress').at(-1);
}

export interface Composed {
  text: string;
  buttons: Button[][];
  summary: Summary;
}

export function compose(ctx: RunContext, jobs: readonly ApiJob[], view: ViewOptions, releaseUrl?: string, now?: number): Composed {
  const summary = summarize(jobs, view, now);
  const text = renderMessage(resolveMeta(ctx), buildJobViews(jobs, view), summary);
  return { text, buttons: buildButtons(resolveLinks(ctx, releaseUrl)), summary };
}

// ---------------------------------------------------------------- main

export async function pipelineMain(base: Omit<PipelineConfig, 'messageId' | 'hiddenSteps'> & { messageId?: number }): Promise<void> {
  const ctx = readContext();
  const tg = telegram(base);
  const gh = github(base, ctx);

  let jobs: ApiJob[] = [];
  try {
    jobs = await gh.listJobs(ctx.runId, ctx.runAttempt);
  } catch (e) {
    core.warning(`tg-notify: не удалось получить шаги задачи, статус шагов не будет обновляться. ${(e as Error).message}`);
  }
  const current = findCurrentJob(jobs, ctx.runnerName);
  // Наш собственный шаг сейчас выполняется: прячем его, даже если у него своё имя.
  const own = current?.steps?.find((s) => s.status === 'in_progress');
  const hiddenSteps = own ? [own.name] : [];
  const view: ViewOptions = { currentJobId: current?.id, hiddenSteps };
  const { text, buttons } = compose(ctx, jobs, view);

  let messageId = base.messageId;
  if (messageId) {
    try {
      await tg.editMessageText(messageId, text, buttons);
    } catch (e) {
      if (!(e instanceof TelegramError && e.messageGone)) throw e;
      core.warning(`tg-notify: сообщение ${messageId} не найдено, отправляю новое`);
      messageId = undefined;
    }
  }
  if (!messageId) messageId = (await tg.sendMessage(text, { buttons, silent: true })).message_id;

  core.setOutput('message_id', String(messageId));
  const cfg: PipelineConfig = { ...base, messageId, currentJobId: current?.id, hiddenSteps };
  core.saveState('config', JSON.stringify({ ...cfg, token: undefined, githubToken: undefined }));
  core.info(`tg-notify: сообщение ${messageId}, задача ${current?.name ?? '(не найдена в API)'}`);

  // Фоновый процесс: опрашивает API и правит сообщение, пока не придёт post.
  const logPath = join(process.env.RUNNER_TEMP ?? '/tmp', `tg-notify-${ctx.runId}-${process.pid}.log`);
  const fd = openSync(logPath, 'a');
  const child = spawn(process.execPath, [process.argv[1]!, '--poller'], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, [POLLER_ENV]: JSON.stringify(cfg) },
  });
  child.unref();
  closeSync(fd);
  core.saveState('poller_pid', String(child.pid ?? ''));
  core.saveState('poller_log', logPath);
}

// ---------------------------------------------------------------- poller

export async function pollerMain(): Promise<void> {
  const cfg = JSON.parse(process.env[POLLER_ENV] ?? '{}') as PipelineConfig;
  const ctx = readContext();
  const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
  const tg = telegram(cfg, log);
  const gh = github(cfg, ctx);
  const deadline = Date.now() + 6 * 3600_000; // дольше задача на GitHub-раннере не живёт
  let last = '';
  let currentJobId = cfg.currentJobId;
  let errors = 0;

  log(`старт, сообщение ${cfg.messageId}`);
  while (Date.now() < deadline) {
    await sleep(cfg.pollIntervalMs);
    try {
      const jobs = await gh.listJobs(ctx.runId, ctx.runAttempt);
      const current = findCurrentJob(jobs, ctx.runnerName, currentJobId);
      currentJobId ??= current?.id;
      if (current?.status === 'completed') {
        log('задача завершена, выхожу');
        return;
      }
      const { text, buttons } = compose(ctx, jobs, { currentJobId, hiddenSteps: cfg.hiddenSteps });
      const key = text + JSON.stringify(buttons);
      if (key !== last) {
        await tg.editMessageText(cfg.messageId, text, buttons);
        last = key;
        log('сообщение обновлено');
      }
      errors = 0;
    } catch (e) {
      log(`ошибка: ${(e as Error).message}`);
      if (e instanceof TelegramError && e.messageGone) return;
      if (++errors >= 20) return;
    }
  }
}

// ---------------------------------------------------------------- post

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopPoller(pid: number): Promise<void> {
  if (!pid || !alive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let i = 0; i < 30 && alive(pid); i++) await sleep(100);
  if (alive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* уже завершился */
    }
  }
}

function printLog(path: string): void {
  if (!path || !existsSync(path)) return;
  const content = readFileSync(path, 'utf8').trim();
  if (!content) return;
  core.startGroup('tg-notify: лог фонового процесса');
  core.info(content.split('\n').slice(-50).join('\n'));
  core.endGroup();
}

export async function pipelinePost(secrets: Pick<PipelineConfig, 'token' | 'githubToken'>): Promise<void> {
  const saved = core.getState('config');
  if (!saved) return;
  const cfg: PipelineConfig = { ...(JSON.parse(saved) as PipelineConfig), ...secrets };
  await stopPoller(Number(core.getState('poller_pid')));
  printLog(core.getState('poller_log'));

  const ctx = readContext();
  const tg = telegram(cfg, (m) => core.info(`tg-notify: ${m}`));
  const gh = github(cfg, ctx);

  // Шаги в API обновляются с задержкой: ждём, пока все видимые шаги нашей задачи завершатся.
  let jobs: ApiJob[] = [];
  let current: ApiJob | undefined;
  for (let i = 0; i < 10; i++) {
    jobs = await gh.listJobs(ctx.runId, ctx.runAttempt);
    current = findCurrentJob(jobs, ctx.runnerName, cfg.currentJobId);
    const pending = buildJobViews(current ? [current] : [], { hiddenSteps: cfg.hiddenSteps })[0]?.steps.some(
      (s) => s.mark === '⏳',
    );
    if (current && !pending) break;
    await sleep(2000);
  }
  const view: ViewOptions = { currentJobId: current?.id, hiddenSteps: cfg.hiddenSteps, final: true };

  let releaseUrl: string | undefined;
  try {
    const run = await gh.getRun(ctx.runId);
    releaseUrl = pickRelease(await gh.listReleases(), { since: run.run_started_at ?? run.created_at })?.html_url;
  } catch {
    /* нет contents: read — без кнопки «Релиз» */
  }

  const { text, buttons, summary } = compose(ctx, jobs, view, releaseUrl);
  await sleep(1000); // не чаще одной правки в секунду после последней правки фонового процесса
  await tg.editMessageText(cfg.messageId, text, buttons);
  core.info(`tg-notify: итог ${summary.state}`);

  // Звук только при провале: отдельный ответ, потому что правки всегда беззвучные.
  const failure = current ? jobFailure(current, view) : undefined;
  if (failure) {
    const reply = renderFailureReply(ctx.repo, { state: 'failure', ...failure });
    const url = failure.failedUrl ?? resolveLinks(ctx).runUrl;
    await tg.sendMessage(reply, { silent: false, replyTo: cfg.messageId, buttons: [[{ text: 'Открыть шаг', url }]] });
  }
}
