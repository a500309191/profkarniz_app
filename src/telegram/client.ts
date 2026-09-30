import { object, type TelegramUpdate } from './normalize.js';
import { createTelegramDispatcher, networkErrorCodes, TELEGRAM_ORIGIN } from './transport.js';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import type { FileDownload } from '../media/types.js';
import { MediaError } from '../media/errors.js';

export class TelegramError extends Error {
  constructor(readonly code: number | 'NETWORK' | 'INVALID_RESPONSE', readonly retryAfter = 0,
    readonly networkCodes: string[] = []) {
    super('Telegram API request failed');
  }
  get fatal() { return [400, 401, 403, 404, 409].includes(Number(this.code)); }
}

export interface TelegramApi {
  getUpdates(offset: number | undefined, signal: AbortSignal): Promise<TelegramUpdate[]>;
}

export class TelegramClient implements TelegramApi {
  private readonly dispatcher = createTelegramDispatcher();

  constructor(
    private readonly token: string,
    private readonly pollTimeoutSeconds: number,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async close() { await this.dispatcher.close(); }

  // This allowlist is deliberately read-only. No send/delete/reaction methods.
  private async request(method: 'getMe' | 'getWebhookInfo' | 'getUpdates' | 'getFile',
    body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const timeout = method === 'getUpdates' ? (this.pollTimeoutSeconds + 10) * 1000 : 15_000;
    try {
      const requestOptions = {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
        dispatcher: this.dispatcher
      };
      const response = await this.fetcher(`${TELEGRAM_ORIGIN}/bot${this.token}/${method}`, requestOptions);
      let data;
      try { data = object(await response.json()); }
      catch { throw new TelegramError(response.ok ? 'INVALID_RESPONSE' : response.status); }
      if (!response.ok || data?.ok !== true) {
        const parameters = object(data?.parameters);
        const retryAfter = typeof parameters?.retry_after === 'number'
          ? Math.max(0, parameters.retry_after) : 0;
        throw new TelegramError(typeof data?.error_code === 'number' ? data.error_code : response.status, retryAfter);
      }
      return data.result;
    } catch (error) {
      // The original error can contain the bot token; intentionally omit cause.
      // eslint-disable-next-line preserve-caught-error
      if (signal.aborted) throw new Error('SHUTTING_DOWN');
      if (error instanceof TelegramError) throw error;
      // Fetch errors may contain the token in the URL; never propagate them.
      throw new TelegramError('NETWORK', 0, networkErrorCodes(error));
    }
  }

  async download(fileId: string, signal: AbortSignal, maxBytes: number): Promise<FileDownload> {
    const file = object(await this.request('getFile', { file_id: fileId }, signal));
    const path = file?.file_path;
    if (typeof path !== 'string' || !path || path.split('/').some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) {
      throw new MediaError('TELEGRAM_FILE_PATH_INVALID', false);
    }
    const reportedSize = typeof file?.file_size === 'number' && Number.isSafeInteger(file.file_size) && file.file_size >= 0
      ? file.file_size : null;
    if (reportedSize !== null && reportedSize > maxBytes) throw new MediaError('MEDIA_TOO_LARGE', false);
    try {
      const options = { signal, dispatcher: this.dispatcher, redirect: 'error' as const };
      const response = await this.fetcher(`${TELEGRAM_ORIGIN}/file/bot${this.token}/${path.split('/').map(encodeURIComponent).join('/')}`, options);
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        if (response.status === 429) throw new TelegramError(429, Number(response.headers.get('retry-after')) || 1);
        if (response.status >= 500) throw new TelegramError(response.status);
        throw new MediaError('TELEGRAM_FILE_UNAVAILABLE', false);
      }
      const length = response.headers.get('content-length');
      const size = length !== null && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : reportedSize;
      if (size !== null && size > maxBytes) {
        await response.body.cancel();
        throw new MediaError('MEDIA_TOO_LARGE', false);
      }
      if (size !== null && reportedSize !== null && size !== reportedSize) {
        await response.body.cancel();
        throw new MediaError('MEDIA_SIZE_MISMATCH', true);
      }
      const body = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      // The worker may await a short DB state change before attaching pipeline.
      body.on('error', () => {});
      return { body, size };
    } catch (error) {
      if (error instanceof MediaError || error instanceof TelegramError) throw error;
      throw new TelegramError('NETWORK', 0, networkErrorCodes(error));
    }
  }

  async verifyIdentity(signal: AbortSignal): Promise<string> {
    const me = object(await this.request('getMe', {}, signal));
    if (typeof me?.id !== 'number' || !Number.isSafeInteger(me.id) || me.is_bot !== true) {
      throw new TelegramError('INVALID_RESPONSE');
    }
    const webhook = object(await this.request('getWebhookInfo', {}, signal));
    if (typeof webhook?.url !== 'string') throw new TelegramError('INVALID_RESPONSE');
    // Never delete an existing webhook or drop pending updates automatically.
    if (webhook.url.length > 0) throw new TelegramError(409);
    return String(me.id);
  }

  async getUpdates(offset: number | undefined, signal: AbortSignal): Promise<TelegramUpdate[]> {
    const result = await this.request('getUpdates', {
      ...(offset === undefined ? {} : { offset }),
      timeout: this.pollTimeoutSeconds,
      limit: 100,
      // Reset any previously configured filter; all default update kinds are kept.
      allowed_updates: []
    }, signal);
    if (!Array.isArray(result) || !result.every(item => {
      const update = object(item);
      return typeof update?.update_id === 'number' && Number.isSafeInteger(update.update_id) &&
        update.update_id >= 0 && update.update_id < Number.MAX_SAFE_INTEGER;
    })) throw new TelegramError('INVALID_RESPONSE');
    return result as TelegramUpdate[];
  }
}
