import { pino } from 'pino';

export function createLogger(level = 'info') {
  return pino({
    level,
    base: { service: 'profkarniz-collector' },
    redact: {
      paths: ['token', 'password', 'TELEGRAM_BOT_TOKEN', 'POSTGRES_PASSWORD',
        'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', '*.S3_ACCESS_KEY_ID', '*.S3_SECRET_ACCESS_KEY',
        '*.token', '*.password', 'req.headers.authorization'],
      censor: '[REDACTED]'
    }
  });
}

// Never log arbitrary Error objects, API descriptions, SQL, URLs or message content.
export function databaseErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error &&
      typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) {
    return error.code;
  }
  return 'DATABASE_ERROR';
}

export function applicationErrorCode(error: unknown): string {
  const known = ['MIGRATIONS_REQUIRED', 'COLLECTOR_ALREADY_RUNNING'];
  if (error instanceof Error && known.includes(error.message)) return error.message;
  return databaseErrorCode(error);
}
