import type { Button } from './types.js';

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
  ) {
    super(`Telegram ${method}: ${code} ${description}`);
  }

  get notModified(): boolean {
    return this.code === 400 && /message is not modified/i.test(this.description);
  }

  get messageGone(): boolean {
    return this.code === 400 && /message to edit not found|message can't be edited|message_id_invalid/i.test(this.description);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TelegramOptions {
  token: string;
  chatId: string;
  threadId?: number;
  apiUrl?: string;
  /** Лог для повторов и ожиданий (по умолчанию молча). */
  log?: (msg: string) => void;
  /** Максимум ожидания по 429 за один вызов, секунд. */
  maxRetryAfter?: number;
}

export interface Message {
  message_id: number;
}

type Body = Record<string, unknown> | FormData;

export class Telegram {
  private readonly base: string;

  constructor(private readonly opts: TelegramOptions) {
    // TELEGRAM_API_URL — свой Bot API сервер (файлы до 2 ГБ) или заглушка в тестах.
    const api = opts.apiUrl ?? process.env.TELEGRAM_API_URL ?? 'https://api.telegram.org';
    this.base = `${api.replace(/\/+$/, '')}/bot${opts.token}`;
  }

  /** Вызов Bot API. На 429 ждёт retry_after и повторяет, на сетевые ошибки — повтор с паузой. */
  async call<T>(method: string, body: Body): Promise<T> {
    const log = this.opts.log ?? (() => {});
    let waited = 0;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res =
          body instanceof FormData
            ? await fetch(`${this.base}/${method}`, { method: 'POST', body, signal: AbortSignal.timeout(120_000) })
            : await fetch(`${this.base}/${method}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(30_000),
              });
      } catch (e) {
        if (attempt >= 3) throw e;
        log(`${method}: сетевая ошибка (${(e as Error).message}), повтор`);
        await sleep(1000 * attempt);
        continue;
      }
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: T;
        error_code?: number;
        description?: string;
        parameters?: { retry_after?: number };
      };
      if (data.ok) return data.result as T;
      const code = data.error_code ?? res.status;
      if (code === 429 && attempt < 6) {
        const after = data.parameters?.retry_after ?? 1;
        if (waited + after > (this.opts.maxRetryAfter ?? 120)) throw new TelegramError(method, code, data.description ?? '');
        log(`${method}: 429, жду ${after} с`);
        waited += after;
        await sleep(after * 1000 + 250);
        continue;
      }
      if (code >= 500 && attempt < 3) {
        await sleep(1000 * attempt);
        continue;
      }
      throw new TelegramError(method, code, data.description ?? res.statusText);
    }
  }

  private target(): Record<string, unknown> {
    const t: Record<string, unknown> = { chat_id: this.opts.chatId };
    if (this.opts.threadId) t.message_thread_id = this.opts.threadId;
    return t;
  }

  private static markup(buttons?: Button[][]): Record<string, unknown> | undefined {
    return buttons && buttons.length ? { inline_keyboard: buttons } : undefined;
  }

  sendMessage(
    text: string,
    opts: { buttons?: Button[][]; silent?: boolean; replyTo?: number } = {},
  ): Promise<Message> {
    return this.call<Message>('sendMessage', {
      ...this.target(),
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      disable_notification: opts.silent ?? true,
      reply_markup: Telegram.markup(opts.buttons),
      reply_parameters: opts.replyTo ? { message_id: opts.replyTo, allow_sending_without_reply: true } : undefined,
    });
  }

  /** Правка текста. «message is not modified» не считается ошибкой. */
  async editMessageText(messageId: number, text: string, buttons?: Button[][]): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: this.opts.chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: Telegram.markup(buttons) ?? { inline_keyboard: [] },
      });
    } catch (e) {
      if (e instanceof TelegramError && e.notModified) return;
      throw e;
    }
  }

  async sendDocument(
    file: { path: string; name: string },
    opts: { caption?: string; buttons?: Button[][]; silent?: boolean; replyTo?: number } = {},
  ): Promise<Message> {
    const { openAsBlob } = await import('node:fs');
    const form = this.form({
      caption: opts.caption,
      parse_mode: opts.caption ? 'HTML' : undefined,
      disable_notification: opts.silent ?? true,
      reply_markup: Telegram.markup(opts.buttons),
      reply_parameters: opts.replyTo ? { message_id: opts.replyTo, allow_sending_without_reply: true } : undefined,
    });
    form.append('document', await openAsBlob(file.path), file.name);
    return this.call<Message>('sendDocument', form);
  }

  /** Альбом документов (2–10 файлов). */
  async sendDocumentGroup(
    files: { path: string; name: string }[],
    opts: { silent?: boolean; replyTo?: number } = {},
  ): Promise<Message[]> {
    const { openAsBlob } = await import('node:fs');
    const form = this.form({
      disable_notification: opts.silent ?? true,
      reply_parameters: opts.replyTo ? { message_id: opts.replyTo, allow_sending_without_reply: true } : undefined,
      media: files.map((_, i) => ({ type: 'document', media: `attach://file${i}` })),
    });
    for (const [i, f] of files.entries()) form.append(`file${i}`, await openAsBlob(f.path), f.name);
    return this.call<Message[]>('sendMediaGroup', form);
  }

  async pinChatMessage(messageId: number): Promise<void> {
    await this.call('pinChatMessage', { chat_id: this.opts.chatId, message_id: messageId, disable_notification: true });
  }

  private form(fields: Record<string, unknown>): FormData {
    const form = new FormData();
    for (const [k, v] of Object.entries({ ...this.target(), ...fields })) {
      if (v === undefined) continue;
      form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    return form;
  }
}
