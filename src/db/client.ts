import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DatabaseConfig } from '../config.js';
import type { Database } from './types.js';

export function createPool(config: DatabaseConfig) {
  return new pg.Pool({
    host: config.PGHOST,
    port: config.PGPORT,
    user: config.POSTGRES_USER,
    password: config.POSTGRES_PASSWORD,
    database: config.POSTGRES_DB,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
    application_name: 'profkarniz-collector',
    keepAlive: true
  });
}

export function createDatabase(pool: pg.Pool) {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
