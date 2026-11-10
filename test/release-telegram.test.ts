import { afterEach, describe, expect, it, vi } from 'vitest';
import { releaseButtons, renderRelease, shortNotes } from '../src/release.js';
import { Telegram, TelegramError } from '../src/telegram.js';

describe('renderRelease', () => {
  it('тег, имя, заметки, экранирование', () => {
    const text = renderRelease({ repo: 'o/r', tag: 'v1.2.0', name: 'Зима <3', notes: '- fix a & b' }, 1024);
    expect(text).toBe('🚀 <b>o/r</b> v1.2.0\nЗима &lt;3\n\n- fix a &amp; b');
  });

  it('укладывается в лимит подписи даже после экранирования', () => {
    const text = renderRelease({ repo: 'o/r', tag: 'v1', notes: '<&>'.repeat(2000) }, 1024);
    expect(text.length).toBeLessThanOrEqual(1024);
    expect(text).not.toMatch(/&[a-z]*$/); // сущность не разорвана
  });

  it('упоминает слишком большие файлы', () => {
    expect(renderRelease({ repo: 'o/r', tag: 'v1', tooLarge: ['os.img'] }, 1024)).toContain('Больше 50 МБ, скачать в релизе: os.img');
  });

  it('shortNotes убирает комментарии и пустые строки', () => {
    expect(shortNotes('a\r\n\r\n\r\n\r\nb<!-- x -->', 100)).toBe('a\n\nb');
    expect(shortNotes('aaaaaaaaaa\nbbbbbbbbbb', 15)).toBe('aaaaaaaaaa…');
  });

  it('кнопки релиза', () => {
    expect(releaseButtons('R', 'C')).toEqual([[{ text: 'Релиз', url: 'R' }, { text: 'Коммит', url: 'C' }]]);
    expect(releaseButtons(undefined, 'C')).toEqual([[{ text: 'Коммит', url: 'C' }]]);
  });
});

describe('Telegram', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('на 429 ждёт retry_after и повторяет', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } }, 429))
      .mockResolvedValueOnce(reply({ ok: true, result: { message_id: 10 } }));
    vi.stubGlobal('fetch', fetch);
    const tg = new Telegram({ token: 't', chatId: '-100', threadId: 7 });
    const p = tg.sendMessage('hi');
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    await expect(p).resolves.toEqual({ message_id: 10 });
    const body = JSON.parse(fetch.mock.calls[1]![1].body);
    expect(body).toMatchObject({
      chat_id: '-100',
      message_thread_id: 7,
      parse_mode: 'HTML',
      disable_notification: true,
      link_preview_options: { is_disabled: true },
    });
  });

  it('«message is not modified» не ошибка', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }, 400)));
    await expect(new Telegram({ token: 't', chatId: '1' }).editMessageText(1, 'x')).resolves.toBeUndefined();
  });

  it('прочие ошибки пробрасываются', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }, 400)));
    const err = await new Telegram({ token: 't', chatId: '1' }).editMessageText(1, 'x').catch((e) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.messageGone).toBe(true);
  });

  it('ответ со звуком через reply_parameters', async () => {
    const fetch = vi.fn().mockResolvedValue(reply({ ok: true, result: { message_id: 2 } }));
    vi.stubGlobal('fetch', fetch);
    await new Telegram({ token: 't', chatId: '1' }).sendMessage('x', { silent: false, replyTo: 1 });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({
      disable_notification: false,
      reply_parameters: { message_id: 1, allow_sending_without_reply: true },
    });
  });
});
