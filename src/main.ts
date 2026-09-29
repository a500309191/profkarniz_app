import { once } from 'node:events';
import { sql } from 'kysely';
import type { Config } from './config.js';
import { readConfig } from './config.js';
import { createDatabase, createPool } from './db/client.js';
import { acquireCollectorLock } from './db/lock.js';
import { assertSchemaReady } from './db/migrations.js';
import { TelegramStore } from './db/store.js';
import { createHealthServer } from './http/health.js';
import { applicationErrorCode, createLogger, databaseErrorCode } from './logger.js';
import { TelegramClient, TelegramError } from './telegram/client.js';
import { collect, verifyTelegram, type CollectorState } from './telegram/collector.js';

async function main(config: Config) {
  const logger = createLogger(config.LOG_LEVEL);
  const controller = new AbortController();
  const state: CollectorState = { phase: 'starting', lastSuccessAt: null, lastError: null };
  const pool = createPool(config);
  const db = createDatabase(pool);
  const server = createHealthServer({ state, staleSeconds: config.HEALTH_STALE_SECONDS,
    checkDatabase: async () => { await sql`SELECT 1`.execute(db); } });
  let lock: Awaited<ReturnType<typeof acquireCollectorLock>> | undefined;
  let api: TelegramClient | undefined;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = (reason: string, failed = false) => {
    if (failed) process.exitCode = 1;
    if (controller.signal.aborted) return;
    state.phase = failed ? 'failed' : 'stopping';
    logger.info({ event: 'shutdown_started', reason });
    controller.abort();
    shutdownTimer = setTimeout(() => {
      logger.fatal({ event: 'shutdown_timeout' });
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_SECONDS * 1000).unref();
  };
  const onTerm = () => stop('SIGTERM');
  const onInt = () => stop('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  pool.on('error', error => logger.error({ event: 'database_pool_error', code: databaseErrorCode(error) }));
  // once(server, 'listening') also rejects on a startup 'error'.
  try {
    logger.info({ event: 'application_starting' });
    server.listen(config.HTTP_PORT, config.HTTP_HOST);
    await once(server, 'listening');
    server.on('error', () => stop('http_error', true));
    await sql`SELECT 1`.execute(db);
    logger.info({ event: 'database_connected' });
    await assertSchemaReady(db);
    if (controller.signal.aborted) return;
    api = new TelegramClient(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_POLL_TIMEOUT_SECONDS);
    logger.info({ event: 'telegram_transport_configured', dns_order: 'ipv6first',
      auto_select_family: true, family_attempt_timeout_ms: 250 });
    const botId = await verifyTelegram({ api, state, signal: controller.signal, logger });
    if (botId === null || controller.signal.aborted) return;
    lock = await acquireCollectorLock(pool, botId, () => stop('collector_lock_lost', true));
    await collect({ api, store: new TelegramStore(db, botId), state,
      signal: controller.signal, logger, assertLeadership: () => lock!.assertHeld() });
  } catch (error) {
    if (!controller.signal.aborted) {
      logger.error({ event: 'application_failed',
        code: error instanceof TelegramError ? error.code : applicationErrorCode(error),
        network_codes: error instanceof TelegramError ? error.networkCodes : undefined });
      stop('fatal_error', true);
    }
  } finally {
    if (!controller.signal.aborted) stop('collector_stopped');
    await new Promise<void>(resolve => server.close(() => resolve()));
    await api?.close();
    lock?.release();
    await db.destroy();
    clearTimeout(shutdownTimer);
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    logger.info({ event: 'application_stopped' });
  }
}

try {
  const config = readConfig();
  await main(config);
} catch {
  // Do not print config/stack: even startup errors may contain secrets.
  createLogger().fatal({ event: 'startup_failed', hint: 'Check environment variables and service configuration' });
  process.exitCode = 1;
}
