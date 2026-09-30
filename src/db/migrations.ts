import { sql, type Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import * as initial from './migrations/001_telegram_ingestion.js';
import * as mediaArchive from './migrations/002_media_archive.js';
import type { Database } from './types.js';
import { databaseErrorCode } from '../logger.js';

export const migrations = { '001_telegram_ingestion': initial, '002_media_archive': mediaArchive };

export function createMigrator(db: Kysely<Database>) {
  return new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
}

export async function assertSchemaReady(db: Kysely<Database>) {
  // Startup only checks; schema changes are an explicit deployment step.
  const result = await sql<{ name: string }>`SELECT name FROM kysely_migration`.execute(db).catch((error: unknown) => {
    if (databaseErrorCode(error) === '42P01') throw new Error('MIGRATIONS_REQUIRED', { cause: error });
    throw error;
  });
  if (Object.keys(migrations).some(name => !result.rows.some(row => row.name === name))) {
    throw new Error('MIGRATIONS_REQUIRED');
  }
}
