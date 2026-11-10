import { statSync } from 'node:fs';
import { basename } from 'node:path';
import * as core from '@actions/core';
import * as glob from '@actions/glob';
import { readContext, resolveLinks } from './context.js';
import { GitHub, pickRelease } from './github.js';
import { escapeHtml } from './render.js';
import { Telegram, type Message } from './telegram.js';
import type { Button } from './types.js';

/** Лимит Bot API на загрузку файла ботом. */
export const FILE_LIMIT = 50 * 1024 * 1024;
/** Лимит подписи к файлу. */
export const CAPTION_LIMIT = 1024;

export interface ReleaseText {
  repo: string;
  tag: string;
  name?: string;
  notes?: string;
  tooLarge?: string[];
}

/** Короткие заметки: без HTML-комментариев и лишних пустых строк, не длиннее max. */
export function shortNotes(notes: string, max: number): string {
  const clean = notes
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const nl = cut.lastIndexOf('\n');
  return `${nl > max / 2 ? cut.slice(0, nl) : cut}…`;
}

export function renderRelease(r: ReleaseText, limit: number): string {
  const head = [`🚀 <b>${escapeHtml(r.repo)}</b> ${escapeHtml(r.tag)}`];
  if (r.name && r.name !== r.tag) head.push(escapeHtml(r.name));
  const tail: string[] = [];
  if (r.tooLarge?.length) tail.push(`⚠️ Больше 50 МБ, скачать в релизе: ${escapeHtml(r.tooLarge.join(', '))}`);
  const build = (max: number) => {
    const notes = r.notes && max > 0 ? escapeHtml(shortNotes(r.notes, max)) : '';
    return [head.join('\n'), notes, ...tail].filter(Boolean).join('\n\n');
  };
  // Экранирование удлиняет текст, поэтому подбираем длину заметок, а не режем готовый HTML.
  let max = limit;
  let out = build(max);
  while (out.length > limit && max > 0) out = build((max -= 64));
  return out;
}

export function releaseButtons(releaseUrl: string | undefined, commitUrl: string): Button[][] {
  const row: Button[] = [];
  if (releaseUrl) row.push({ text: 'Релиз', url: releaseUrl });
  row.push({ text: 'Коммит', url: commitUrl });
  return [row];
}

export interface ReleaseInputs {
  token: string;
  chatId: string;
  threadId?: number;
  githubToken: string;
  files: string;
  tag: string;
  notes: string;
}

export async function releaseMain(inp: ReleaseInputs): Promise<void> {
  const ctx = readContext();
  const tg = new Telegram({ token: inp.token, chatId: inp.chatId, threadId: inp.threadId, log: (m) => core.info(m) });
  const gh = new GitHub(inp.githubToken, ctx.apiUrl, ctx.repo);

  let tag = inp.tag || (ctx.ref.startsWith('refs/tags/') ? ctx.refName : '');
  let releaseUrl: string | undefined;
  let name: string | undefined;
  let notes = inp.notes;
  try {
    const run = await gh.getRun(ctx.runId);
    const rel = pickRelease(await gh.listReleases(), { tag, since: tag ? undefined : (run.run_started_at ?? run.created_at) });
    if (rel) {
      tag ||= rel.tag_name;
      releaseUrl = rel.html_url;
      name = rel.name ?? undefined;
      notes ||= rel.body ?? '';
    } else {
      core.warning('tg-notify: релиз этого запуска не найден, кнопки «Релиз» не будет');
    }
  } catch (e) {
    core.warning(`tg-notify: не удалось получить релизы: ${(e as Error).message}`);
  }
  tag ||= ctx.sha.slice(0, 7);

  const files: { path: string; name: string }[] = [];
  const tooLarge: string[] = [];
  if (inp.files.trim()) {
    const globber = await glob.create(inp.files, { matchDirectories: false });
    for (const path of await globber.glob()) {
      const size = statSync(path).size;
      if (size > FILE_LIMIT) {
        tooLarge.push(basename(path));
        core.warning(`tg-notify: ${path} больше 50 МБ (${(size / 1048576).toFixed(1)} МБ), не прикладываю`);
      } else files.push({ path, name: basename(path) });
    }
    if (!files.length && !tooLarge.length) core.warning(`tg-notify: по маске files ничего не найдено: ${inp.files}`);
  }

  const buttons = releaseButtons(releaseUrl, resolveLinks(ctx).commitUrl);
  const info = { repo: ctx.repo, tag, name, notes, tooLarge };
  let main: Message;
  if (files.length === 1) {
    main = await tg.sendDocument(files[0]!, { caption: renderRelease(info, CAPTION_LIMIT), buttons });
  } else {
    main = await tg.sendMessage(renderRelease(info, 4096), { buttons });
    // Альбом — от 2 до 10 файлов; одиночный остаток отправляем обычным документом.
    for (let i = 0; i < files.length; i += 10) {
      const chunk = files.slice(i, i + 10);
      if (chunk.length === 1) await tg.sendDocument(chunk[0]!, { replyTo: main.message_id });
      else await tg.sendDocumentGroup(chunk, { replyTo: main.message_id });
    }
  }
  core.setOutput('message_id', String(main.message_id));

  try {
    await tg.pinChatMessage(main.message_id);
  } catch (e) {
    core.warning(`tg-notify: не удалось закрепить сообщение (боту нужно право закреплять): ${(e as Error).message}`);
  }
}
