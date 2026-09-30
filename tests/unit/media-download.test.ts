import { describe, expect, it, vi } from 'vitest';
import { TelegramClient } from '../../src/telegram/client.js';
import { hashStream } from '../../src/media/streams.js';
import { createHash } from 'node:crypto';

const signal = new AbortController().signal;
const token = '123:TEST_ONLY';
const fileResponse = (file: object) => new Response(JSON.stringify({ ok: true, result: file }));

describe('Telegram file download', () => {
  it('uses getFile and the same IPv6-first dispatcher with hostname TLS for the streamed download', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(fileResponse({ file_path: 'documents/file_1.bin', file_size: 3 }))
      .mockResolvedValueOnce(new Response('abc', { headers: { 'content-length': '3' } }));
    const client = new TelegramClient(token, 30, fetcher);
    try {
      const file = await client.download('opaque-file-id', signal, 100);
      expect(await hashStream(file.body, 100, file.size, signal)).toEqual({ size: 3, sha256: createHash('sha256').update('abc').digest('hex') });
      expect(fetcher.mock.calls[0]![0]).toBe(`https://api.telegram.org/bot${token}/getFile`);
      expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ file_id: 'opaque-file-id' });
      expect(fetcher.mock.calls[1]![0]).toBe(`https://api.telegram.org/file/bot${token}/documents/file_1.bin`);
      const first = fetcher.mock.calls[0]![1] as RequestInit & { dispatcher: unknown };
      const second = fetcher.mock.calls[1]![1] as RequestInit & { dispatcher: unknown };
      expect(first.dispatcher).toBeDefined();
      expect(second.dispatcher).toBe(first.dispatcher);
      expect(second.redirect).toBe('error');
      expect(file).not.toHaveProperty('url');
    } finally { await client.close(); }
  });

  it.each(['../secret', '/absolute', 'https://other.test/file', 'dir/../file', 'dir/file?token=secret', ''])('rejects unsafe paths: %s', async file_path => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(fileResponse({ file_path }));
    const client = new TelegramClient(token, 30, fetcher);
    try {
      await expect(client.download('file', signal, 100)).rejects.toMatchObject({ code: 'TELEGRAM_FILE_PATH_INVALID' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { await client.close(); }
  });

  it('rejects files exceeding the configured limit before downloading', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(fileResponse({ file_path: 'dir/file', file_size: 101 }));
    const client = new TelegramClient(token, 30, fetcher);
    try {
      await expect(client.download('file', signal, 100)).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { await client.close(); }
  });

  it.each([400, 429, 503])('handles download HTTP %s without revealing the token or URL', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(fileResponse({ file_path: 'dir/file' }))
      .mockResolvedValueOnce(new Response('private response', { status, headers: { 'retry-after': '30' } }));
    const client = new TelegramClient(token, 30, fetcher);
    try {
      await expect(client.download('file', signal, 100)).rejects.toMatchObject({ code: status === 400 ? 'TELEGRAM_FILE_UNAVAILABLE' : status });
    } finally { await client.close(); }
  });

  it('supports missing length and rejects inconsistent length', async () => {
    for (const known of [false, true]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(fileResponse({ file_path: 'dir/file', ...(known ? { file_size: 5 } : {}) }))
        .mockResolvedValueOnce(new Response('abc', known ? { headers: { 'content-length': '3' } } : {}));
      const client = new TelegramClient(token, 30, fetcher);
      try {
        if (known) await expect(client.download('file', signal, 100)).rejects.toMatchObject({ code: 'MEDIA_SIZE_MISMATCH' });
        else {
          const file = await client.download('file', signal, 100);
          expect(file.size).toBeNull();
          expect((await hashStream(file.body, 100, null, signal)).size).toBe(3);
        }
      } finally { await client.close(); }
    }
  });
});
