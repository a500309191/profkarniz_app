import { readDatabaseConfig } from '../config.js';
import { createLogger, databaseErrorCode } from '../logger.js';
import { createDatabase, createPool } from './client.js';
import { createMigrator } from './migrations.js';

const logger = createLogger();
try {
  const pool = createPool(readDatabaseConfig());
  pool.on('error', error => logger.error({ event: 'database_pool_error', code: databaseErrorCode(error) }));
  const db = createDatabase(pool);
  try {
    const { results, error } = await createMigrator(db).migrateToLatest();
    for (const result of results ?? []) {
      logger.info({ event: 'migration', name: result.migrationName, status: result.status });
    }
    if (error) throw error;
    logger.info({ event: 'migrations_complete' });
  } finally {
    await db.destroy();
  }
} catch (error) {
  logger.error({ event: 'migration_failed', code: databaseErrorCode(error) });
  process.exitCode = 1;
}
