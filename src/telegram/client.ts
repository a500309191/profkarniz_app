import { object, type TelegramUpdate } from './normalize.js';

export class TelegramError extends Error {
  constructor(readonly code: number | 'NETWORK' | 'INVALID_RESPONSE', readonly retryAfter = 0) {
    super('Telegram API request failed');
  }
  get fatal() { return [400, 401, 403, 404, 409].includes(Number(this.code)); }
}

export interface TelegramApi {
  getUpdates(offset: number | undefined, signal: AbortSignal): Promise<TelegramUpdate[]>;
}

export class TelegramClient implements TelegramApi {
  constructor(
    private readonly token: string,
    private readonly pollTimeoutSeconds: number,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  // This allowlist is deliberately read-only. No send/delete/reaction methods.
  private async request(method: 'getMe' | 'getWebhookInfo' | 'getUpdates',
    body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const timeout = method === 'getUpdates' ? (this.pollTimeoutSeconds + 10) * 1000 : 15_000;
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)])
      });
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
      throw new TelegramError('NETWORK');
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
