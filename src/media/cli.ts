import { readConfig } from '../config.js';
import { createDatabase, createPool } from '../db/client.js';
import { assertSchemaReady } from '../db/migrations.js';
import { createLogger, databaseErrorCode } from '../logger.js';
import { readS3Config } from './config.js';
import { classifyMediaError, s3ErrorDetails } from './errors.js';
import { MediaRepository } from './repository.js';
import { checkS3Access, createS3Client, type S3CheckOperation } from './s3.js';

const logger = createLogger();
const controller = new AbortController();
let deadline: ReturnType<typeof setTimeout> | undefined;
const stop = () => {
  controller.abort();
  deadline ??= setTimeout(() => process.exit(1), 25_000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const command = process.argv[2];
let s3Operation: S3CheckOperation | 'Configuration' = 'Configuration';
try {
  if (command === 's3-check') {
    const config = readS3Config();
    const client = createS3Client(config);
    try {
      logger.info({ event: 's3_check_started', addressing_style: config.S3_FORCE_PATH_STYLE === 'true' ? 'path' : 'virtual-hosted' });
      const key = await checkS3Access(client, config.S3_BUCKET,
        AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]), operation => {
          s3Operation = operation;
          logger.info({ event: 's3_check_operation', operation });
        });
      logger.info({ event: 's3_check_succeeded', technical_object_key: key, retained: true });
    } finally { client.destroy(); }
  } else if (command === 'backfill' || command === 'retry-failed') {
    const config = readConfig();
    if (!config.media.enabled) throw new Error('MEDIA_ARCHIVE_DISABLED');
    const pool = createPool(config);
    pool.on('error', error => logger.error({ event: 'database_pool_error', code: databaseErrorCode(error) }));
    const db = createDatabase(pool);
    try {
      await assertSchemaReady(db);
      // Token prefix is the bot ID; no Telegram HTTP request or token CLI argument.
      const repository = new MediaRepository(db, config.TELEGRAM_BOT_TOKEN.split(':')[0]!, config.media);
      const count = command === 'backfill' ? await repository.backfill(controller.signal) : await repository.retryFailed();
      logger.info({ event: command === 'backfill' ? 'media_backfill_complete' : 'media_retry_queued', count });
    } finally { await db.destroy(); }
  } else throw new Error('INVALID_MEDIA_COMMAND');
  if (controller.signal.aborted) process.exitCode = 1;
} catch (error) {
  logger.error({ event: 'media_command_failed', code: classifyMediaError(error, command === 's3-check' ? 's3' : 'database').code,
    ...(command === 's3-check' ? { operation: s3Operation, ...s3ErrorDetails(error) } : {}),
    hint: 'Check required environment variables, migrations and service access' });
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
