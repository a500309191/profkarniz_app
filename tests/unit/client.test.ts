import { describe, expect, it, vi } from 'vitest';
import { TelegramClient, TelegramError } from '../../src/telegram/client.js';
import { textUpdate } from '../fixtures.js';

// Deliberately invalid fixture token, never a real Telegram credential.
const token = '123:TEST_ONLY';
const signal = new AbortController().signal;

describe('read-only Telegram client', () => {
  it('uses long polling and preserves unknown JSON fields', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: [textUpdate] })));
    expect(await new TelegramClient(token, 30, fetcher).getUpdates(100, signal)).toEqual([textUpdate]);
    const call = fetcher.mock.calls[0]!;
    expect(call[0]).toBe(`https://api.telegram.org/bot${token}/getUpdates`);
    expect(call[1]).toHaveProperty('dispatcher');
    expect(JSON.parse(call[1]!.body as string)).toEqual({ offset: 100, timeout: 30, limit: 100, allowed_updates: [] });
  });

  it('reuses a dedicated dispatcher for all Bot API methods and closes it', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"ok":true,"result":{"id":123,"is_bot":true}}'))
      .mockResolvedValueOnce(new Response('{"ok":true,"result":{"url":""}}'))
      .mockResolvedValueOnce(new Response('{"ok":true,"result":[]}'));
    const client = new TelegramClient(token, 30, fetcher);
    try {
      await client.verifyIdentity(signal);
      await client.getUpdates(undefined, signal);
      const dispatchers = fetcher.mock.calls.map(call => (call[1] as { dispatcher: unknown }).dispatcher);
      expect(dispatchers[0]).toBeDefined();
      expect(new Set(dispatchers).size).toBe(1);
      expect(fetcher.mock.calls.every(call => new URL(String(call[0])).hostname === 'api.telegram.org')).toBe(true);
    } finally { await client.close(); }
  });

  it('retains sanitized Undici timeout codes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('fetch failed', {
      cause: Object.assign(new Error(`secret ${token}`), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    }));
    const client = new TelegramClient(token, 30, fetcher);
    try {
      await expect(client.verifyIdentity(signal)).rejects.toMatchObject({
        code: 'NETWORK', networkCodes: ['UND_ERR_CONNECT_TIMEOUT'], message: 'Telegram API request failed'
      });
    } finally { await client.close(); }
  });

  it('omits offset for the first poll, retaining all pending updates', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ok":true,"result":[]}'));
    await new TelegramClient(token, 30, fetcher).getUpdates(undefined, signal);
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).not.toHaveProperty('offset');
  });

  it('does not expose token, server description or request URL in errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(`request https://api.telegram.org/bot${token}/getUpdates`));
    await expect(new TelegramClient(token, 30, fetcher).getUpdates(1, signal))
      .rejects.toMatchObject({ message: 'Telegram API request failed', code: 'NETWORK' });
    fetcher.mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 429,
      description: `secret ${token}`, parameters: { retry_after: 20 } }), { status: 429 }));
    try { await new TelegramClient(token, 30, fetcher).getUpdates(1, signal); }
    catch (error) {
      expect(error).toMatchObject({ code: 429, retryAfter: 20 });
      expect(String(error)).not.toContain(token);
    }
  });

  it('rejects malformed update ids without confirming them', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ok":true,"result":[{"update_id":"invalid"}]}'));
    await expect(new TelegramClient(token, 30, fetcher).getUpdates(1, signal))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('refuses an existing webhook without deleting it', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"ok":true,"result":{"id":123,"is_bot":true}}'))
      .mockResolvedValueOnce(new Response('{"ok":true,"result":{"url":"https://example.test/hook"}}'));
    await expect(new TelegramClient(token, 30, fetcher).verifyIdentity(signal)).rejects.toEqual(new TelegramError(409));
    expect(fetcher.mock.calls.map(call => String(call[0]).split('/').at(-1))).toEqual(['getMe', 'getWebhookInfo']);
  });

  it('cancels a long poll when shutdown starts', async () => {
    const stop = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      stop.abort();
      options?.signal?.throwIfAborted();
      return new Response();
    });
    await expect(new TelegramClient(token, 30, fetcher).getUpdates(1, stop.signal))
      .rejects.toThrow('SHUTTING_DOWN');
  });
});
