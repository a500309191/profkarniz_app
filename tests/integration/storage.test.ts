import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sql } from 'kysely';
import { createDatabase } from '../../src/db/client.js';
import { acquireCollectorLock } from '../../src/db/lock.js';
import { assertSchemaReady, createMigrator } from '../../src/db/migrations.js';
import { TelegramStore } from '../../src/db/store.js';
import type { JsonObject } from '../../src/telegram/normalize.js';
import { textUpdate } from '../fixtures.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required; use docker-compose.test.yml');
const target = new URL(connectionString);
if (!target.pathname.endsWith('_test')) throw new Error('Integration database name must end with _test');
const schema = `collector_test_${randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString });
const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema},public`, max: 8 });
const db = createDatabase(pool);

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const { error } = await createMigrator(db).migrateToLatest();
  if (error) throw error;
});
afterAll(async () => {
  await db.destroy();
  // Only this test's randomly named schema in an explicitly designated test DB.
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
});

async function counts(botId: string) {
  const updates = await db.selectFrom('telegram_updates').select('id').where('bot_id', '=', botId).execute();
  const messages = await db.selectFrom('telegram_messages').select('id').where('bot_id', '=', botId).execute();
  const events = await db.selectFrom('telegram_message_events as e')
    .innerJoin('telegram_messages as m', 'm.id', 'e.telegram_message_id')
    .select('e.id').where('m.bot_id', '=', botId).execute();
  return { updates: updates.length, messages: messages.length, events: events.length };
}

describe('PostgreSQL durability and idempotency', () => {
  it('applies versioned migrations once and checks schema at startup', async () => {
    await assertSchemaReady(db);
    const { results, error } = await createMigrator(db).migrateToLatest();
    expect(error).toBeUndefined();
    expect(results).toHaveLength(0);
  });

  it('deduplicates updates across retries and concurrent deliveries', async () => {
    const store = new TelegramStore(db, '1001');
    await Promise.all(Array.from({ length: 5 }, () => store.saveBatch([textUpdate, textUpdate])));
    expect(await counts('1001')).toEqual({ updates: 1, messages: 1, events: 1 });
    expect((await new TelegramStore(db, '1001').loadCursor()).offset).toBe(102);
    const raw = await db.selectFrom('telegram_updates').select('raw_update')
      .where('bot_id', '=', '1001').executeTakeFirstOrThrow();
    expect(raw.raw_update).toEqual(textUpdate);
  });

  it('keeps immutable edit history with one message identity', async () => {
    const store = new TelegramStore(db, '1002');
    await store.saveBatch([textUpdate]);
    await store.saveBatch([{ update_id: 102, edited_message: {
      ...textUpdate.message as JsonObject, text: 'Исправление', edit_date: 1_750_000_100
    } }]);
    expect(await counts('1002')).toEqual({ updates: 2, messages: 1, events: 2 });
    const events = await db.selectFrom('telegram_message_events as e')
      .innerJoin('telegram_messages as m', 'm.id', 'e.telegram_message_id')
      .select(['e.text', 'e.edited_at']).where('m.bot_id', '=', '1002').orderBy('e.id').execute();
    expect(events.map(event => event.text)).toEqual(['Тестовое сообщение', 'Исправление']);
    expect(events[1]?.edited_at?.getTime()).toBe(1_750_000_100_000);
  });

  it('deduplicates the message identity even if another update refers to it', async () => {
    const store = new TelegramStore(db, '1003');
    await store.saveBatch([textUpdate, { ...textUpdate, update_id: 102 }]);
    expect(await counts('1003')).toEqual({ updates: 2, messages: 1, events: 2 });
  });

  it('stores unknown/non-message updates and optional-less messages losslessly', async () => {
    const store = new TelegramStore(db, '1004');
    await store.saveBatch([{ update_id: 1, future_event: { unknown: ['data', 1] } },
      { update_id: 2, message: { message_id: 3, chat: { id: -100 }, new_chat_title: 'Test' } }]);
    expect(await counts('1004')).toEqual({ updates: 2, messages: 1, events: 1 });
    expect((await store.loadCursor()).offset).toBe(3);
  });

  it('stores albums as separate messages linked by chat and media_group_id', async () => {
    const store = new TelegramStore(db, '1005');
    await store.saveBatch([1, 2].map(index => ({ update_id: index, message: {
      message_id: index, chat: { id: -100 }, date: 1_750_000_000, media_group_id: 'album-test',
      photo: [{ file_id: `file-${index}`, file_unique_id: `unique-${index}`, width: 90, height: 90 }]
    } })));
    expect(await counts('1005')).toEqual({ updates: 2, messages: 2, events: 2 });
    const events = await db.selectFrom('telegram_message_events').select(['attachments', 'media_group_id'])
      .where('media_group_id', '=', 'album-test').orderBy('id').execute();
    expect(events[0]?.attachments[0]?.file_id).toBe('file-1');
    expect(events[1]?.attachments[0]?.file_unique_id).toBe('unique-2');
  });

  it('rolls back raw data, projection and cursor together on a failed batch', async () => {
    const store = new TelegramStore(db, '1006');
    await store.saveBatch([textUpdate]);
    await sql`
      CREATE FUNCTION fail_test_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.text = 'force-test-failure' THEN RAISE EXCEPTION 'injected failure'; END IF;
      RETURN NEW; END; $$;
      CREATE TRIGGER fail_test_event BEFORE INSERT ON telegram_message_events
        FOR EACH ROW EXECUTE FUNCTION fail_test_event();
    `.execute(db);
    try {
      await expect(store.saveBatch([
        { update_id: 102, message: { ...textUpdate.message as JsonObject, message_id: 52 } },
        { update_id: 103, message: { ...textUpdate.message as JsonObject, message_id: 53, text: 'force-test-failure' } }
      ])).rejects.toThrow('injected failure');
      expect(await counts('1006')).toEqual({ updates: 1, messages: 1, events: 1 });
      expect((await store.loadCursor()).offset).toBe(102);
    } finally {
      await sql`DROP TRIGGER fail_test_event ON telegram_message_events; DROP FUNCTION fail_test_event();`.execute(db);
    }
  });

  it.each(['UPDATE telegram_updates SET update_type = update_type',
    'DELETE FROM telegram_updates', 'TRUNCATE telegram_updates CASCADE',
    'UPDATE telegram_message_events SET text = text', 'DELETE FROM telegram_message_events',
    'TRUNCATE telegram_message_events'])('rejects history mutation: %s', async statement => {
    await expect(sql.raw(statement).execute(db)).rejects.toThrow('append-only');
  });

  it('holds an exclusive session lock and releases it for a new collector', async () => {
    const lock = await acquireCollectorLock(pool, '9001', () => {});
    try {
      await expect(acquireCollectorLock(pool, '9001', () => {})).rejects.toThrow('COLLECTOR_ALREADY_RUNNING');
      await lock.assertHeld();
    } finally { lock.release(); }
    const replacement = await acquireCollectorLock(pool, '9001', () => {});
    replacement.release();
  });
});

it.skipIf(process.platform === 'win32')('runs the actual app, persists a mock update, serves health and drains SIGTERM', async () => {
  const portServer = createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const address = portServer.address();
  if (!address || typeof address === 'string') throw new Error('Expected port');
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('../mock-telegram.mjs', import.meta.url)),
    fileURLToPath(new URL('../../dist/main.js', import.meta.url))], {
    env: { ...process.env, TELEGRAM_BOT_TOKEN: '80001:TEST_ONLY', POSTGRES_USER: decodeURIComponent(target.username),
      POSTGRES_PASSWORD: decodeURIComponent(target.password), POSTGRES_DB: target.pathname.slice(1),
      PGHOST: target.hostname, PGPORT: target.port || '5432', PGOPTIONS: `-c search_path=${schema},public`,
      HTTP_HOST: '127.0.0.1', HTTP_PORT: String(address.port), TELEGRAM_POLL_TIMEOUT_SECONDS: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exit = once(child, 'exit');
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { healthy = (await fetch(`http://127.0.0.1:${address.port}/health`)).ok; }
      catch { /* Wait for actual HTTP startup. */ }
      if (healthy || child.exitCode !== null) break;
      await delay(100);
    }
    expect(healthy, output).toBe(true);
    expect(await counts('80001')).toEqual({ updates: 1, messages: 1, events: 1 });
    child.kill('SIGTERM');
    expect((await exit)[0], output).toBe(0);
    expect(output).toContain('application_stopped');
    expect(output).not.toContain('80001:TEST_ONLY');
    expect(output).not.toContain('private mock message');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exit;
  }
});
