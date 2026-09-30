import { TelegramError } from '../telegram/client.js';

export class MediaError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, readonly retryAfterMs = 0) { super(code); }
}
export function classifyMediaError(error: unknown, stage: 'telegram' | 's3' | 'database'): MediaError {
  if (error instanceof MediaError) return error;
  if (error instanceof TelegramError) {
    if (error.code === 429) return new MediaError('TELEGRAM_RATE_LIMIT', true, error.retryAfter * 1000);
    if ([401, 403, 404].includes(Number(error.code))) return new MediaError('TELEGRAM_AUTH', false);
    if (error.code === 400) return new MediaError('TELEGRAM_FILE_UNAVAILABLE', false);
    return new MediaError('TELEGRAM_NETWORK', true);
  }
  if (stage === 's3' && typeof error === 'object' && error !== null) {
    const status = '$metadata' in error && typeof error.$metadata === 'object' && error.$metadata !== null &&
      'httpStatusCode' in error.$metadata ? Number(error.$metadata.httpStatusCode) : 0;
    if (status === 401 || status === 403) return new MediaError('S3_ACCESS_DENIED', false);
    if (status === 404) return new MediaError('S3_NOT_FOUND', false);
    if (status === 412 || status === 409) return new MediaError('S3_WRITE_CONFLICT', true);
    if (status === 429) return new MediaError('S3_RATE_LIMIT', true);
    if (status >= 500) return new MediaError('S3_UNAVAILABLE', true);
    if (status >= 400) return new MediaError('S3_REQUEST_REJECTED', false);
  }
  return new MediaError(stage === 'database' ? 'MEDIA_DATABASE' : stage === 's3' ? 'S3_NETWORK' : 'TELEGRAM_NETWORK', true);
}

export function retryAt(error: MediaError, attempt: number, maxAttempts: number, now = Date.now(), random = Math.random) {
  if (!error.retryable || attempt >= maxAttempts) return null;
  const base = Math.min(3_600_000, 5000 * 2 ** Math.min(attempt - 1, 10));
  return new Date(now + Math.max(error.retryAfterMs, Math.round(base * (0.5 + random()))));
}
