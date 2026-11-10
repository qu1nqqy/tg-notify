import * as core from '@actions/core';
import { pipelineMain, pipelinePost, pollerMain } from './pipeline.js';
import { releaseMain } from './release.js';

/** Число или undefined: пустые входы и мусор не роняют задачу. */
function int(value: string): number | undefined {
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) && n !== 0 ? n : undefined;
}

function secrets(): { token: string; chatId: string; githubToken: string } | undefined {
  const token = core.getInput('token');
  const chatId = core.getInput('chat_id');
  const githubToken = core.getInput('github_token');
  if (token) core.setSecret(token);
  if (!token || !chatId) {
    const missing = [!token && 'token', !chatId && 'chat_id'].filter(Boolean).join(' и ');
    core.warning(
      `tg-notify: пустой ${missing} — уведомление пропущено. Задайте секреты TELEGRAM_TOKEN и TELEGRAM_CHAT_ID ` +
        '(в репозитории или организации), сборка продолжится без уведомлений.',
    );
    return undefined;
  }
  return { token, chatId, githubToken };
}

async function main(): Promise<void> {
  core.saveState('is_post', 'true');
  const mode = (core.getInput('mode') || 'pipeline').trim().toLowerCase();
  core.saveState('mode', mode);
  const s = secrets();
  if (!s) {
    // Следующая задача продолжит то же сообщение, если оно было.
    const passthrough = core.getInput('message_id');
    if (passthrough) core.setOutput('message_id', passthrough);
    return;
  }
  const threadId = int(core.getInput('topic_id'));
  if (mode === 'release') {
    await releaseMain({
      ...s,
      threadId,
      files: core.getInput('files'),
      tag: core.getInput('tag'),
      notes: core.getInput('notes'),
    });
    return;
  }
  if (mode !== 'pipeline') core.warning(`tg-notify: неизвестный mode «${mode}», использую pipeline`);
  const interval = Math.max(3, int(core.getInput('poll_interval')) ?? 5);
  await pipelineMain({
    ...s,
    threadId,
    messageId: int(core.getInput('message_id')),
    pollIntervalMs: interval * 1000,
    title: core.getInput('title') || undefined,
  });
}

async function post(): Promise<void> {
  if (core.getState('mode') === 'release') return;
  const token = core.getInput('token');
  if (!token) return;
  core.setSecret(token);
  await pipelinePost({ token, githubToken: core.getInput('github_token') });
}

async function run(): Promise<void> {
  if (process.argv.includes('--poller')) {
    await pollerMain().catch((e) => console.error(e));
    return;
  }
  const isPost = core.getState('is_post') === 'true';
  try {
    await (isPost ? post() : main());
  } catch (e) {
    // Уведомление никогда не роняет сборку.
    core.warning(`tg-notify: ${(e as Error).message}`);
  }
}

await run();
