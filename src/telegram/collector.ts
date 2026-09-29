import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from 'pino';
import { CURSOR_TTL_MS, type UpdateStore } from '../db/store.js';
import { databaseErrorCode } from '../logger.js';
import { TelegramError, type TelegramApi } from './client.js';

export interface CollectorState {
  phase: 'starting' | 'running' | 'retrying' | 'stopping' | 'failed';
  lastSuccessAt: number | null;
  lastError: 'telegram' | 'database' | null;
}

export async function pause(ms: number, signal: AbortSignal) {
  try { await delay(ms, undefined, { signal }); }
  catch (error) { if (!signal.aborted) throw error; }
}

export async function collect(options: {
  api: TelegramApi;
  store: UpdateStore;
  state: CollectorState;
  signal: AbortSignal;
  logger: Logger;
  assertLeadership: () => Promise<void>;
  sleep?: typeof pause;
  now?: () => number;
}) {
  const { api, store, state, signal, logger, assertLeadership } = options;
  const sleep = options.sleep ?? pause;
  const now = options.now ?? Date.now;
  let cursor = await store.loadCursor();
  let failures = 0;
  logger.info({ event: 'polling_started' });
  while (!signal.aborted) {
    let stage: 'telegram' | 'database' = 'database';
    try {
      await assertLeadership();
      if (signal.aborted) break;
      const offset = cursor.lastUpdateAt !== null && now() - cursor.lastUpdateAt < CURSOR_TTL_MS
        ? cursor.offset : undefined;
      stage = 'telegram';
      const updates = await api.getUpdates(offset, signal);
      if (signal.aborted) break;
      stage = 'database';
      if (updates.length > 0) {
        logger.info({ event: 'updates_received', count: updates.length });
        const saved = await store.saveBatch(updates);
        // The next request acknowledges this batch only after PostgreSQL COMMIT.
        cursor = saved.cursor;
        logger.info({ event: 'updates_saved', inserted: saved.inserted,
          duplicates: saved.duplicates, messages: saved.messages });
      }
      failures = 0;
      state.phase = 'running';
      state.lastSuccessAt = now();
      state.lastError = null;
    } catch (error) {
      if (signal.aborted) break;
      state.lastError = stage;
      if (error instanceof TelegramError && error.fatal) {
        state.phase = 'failed';
        logger.error({ event: 'telegram_fatal', code: error.code });
        throw error;
      }
      state.phase = 'retrying';
      failures++;
      const backoff = Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
      const waitMs = Math.max(backoff + Math.floor(Math.random() * 250),
        error instanceof TelegramError ? error.retryAfter * 1000 : 0);
      logger.error({ event: stage === 'telegram' ? 'telegram_error' : 'database_error',
        code: error instanceof TelegramError ? error.code : databaseErrorCode(error), retry_ms: waitMs });
      await sleep(waitMs, signal);
    }
  }
}
