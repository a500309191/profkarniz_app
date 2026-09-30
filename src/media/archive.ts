import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Logger } from 'pino';
import type { EnabledMediaConfig } from './config.js';
import { classifyMediaError, MediaError, retryAt } from './errors.js';
import type { MediaRepository } from './repository.js';
import { HashAndCount, hashStream } from './streams.js';
import type { ArchiveStorage, MediaJob, TelegramFiles } from './types.js';

export async function archiveJob(options: {
  job: MediaJob; repository: Pick<MediaRepository, 'uploading' | 'complete' | 'failure'>;
  files: TelegramFiles; storage: ArchiveStorage; config: EnabledMediaConfig;
  signal: AbortSignal; logger: Logger;
}) {
  const { job, repository, files, storage, config, logger } = options;
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal, AbortSignal.timeout(config.MEDIA_JOB_TIMEOUT_SECONDS * 1000)]);
  let stage: 'telegram' | 's3' | 'database' = 's3';
  const started = Date.now();
  let tempDirectory: string | undefined;
  let source: Readable | undefined;
  try {
    if (job.s3_endpoint !== config.s3.S3_ENDPOINT || job.s3_bucket !== config.s3.S3_BUCKET) {
      throw new MediaError('S3_DESTINATION_CHANGED', false);
    }
    const existing = await storage.head(job, signal);
    let result;
    if (existing) {
      if (existing.archiveId !== job.id) throw new MediaError('S3_IDENTITY_MISMATCH', false);
      if (existing.size > config.MEDIA_MAX_FILE_BYTES) throw new MediaError('MEDIA_TOO_LARGE', false);
      source = await storage.get(job, signal);
      const measured = await hashStream(source, config.MEDIA_MAX_FILE_BYTES, existing.size, signal);
      result = { ...measured, etag: existing.etag };
    } else {
      if (job.telegram_reported_size !== null && Number(job.telegram_reported_size) > config.MEDIA_MAX_FILE_BYTES) {
        throw new MediaError('MEDIA_TOO_LARGE', false);
      }
      stage = 'telegram';
      logger.info({ event: 'media_download_started', media_id: job.id, media_type: job.media_type });
      const download = await files.download(job.telegram_file_id, signal, config.MEDIA_MAX_FILE_BYTES);
      source = download.body;
      const meter = new HashAndCount(config.MEDIA_MAX_FILE_BYTES, download.size);
      if (download.size === null) {
        // Rare getFile/HTTP responses without length: bounded temporary spool,
        // then a single streaming PUT. Never buffer a whole file in RAM and
        // never require AbortMultipartUpload/DeleteObject permissions.
        tempDirectory = await mkdtemp(join(tmpdir(), 'profkarniz-media-'));
        const path = join(tempDirectory, 'payload');
        await pipeline(source, meter, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
        stage = 'database';
        await repository.uploading(job);
        stage = 's3';
        logger.info({ event: 'media_upload_started', media_id: job.id, size: meter.size });
        source = createReadStream(path);
        const etag = await storage.put(job, source, meter.size, signal);
        result = { ...meter.result(), etag };
      } else {
        stage = 'database';
        await repository.uploading(job);
        stage = 's3';
        logger.info({ event: 'media_upload_started', media_id: job.id, size: download.size });
        const uploadBody = new PassThrough();
        let firstFailure: MediaError | undefined;
        // Both branches are observed immediately. Any failure cancels the other
        // branch, so a rejected S3 PUT cannot leave a blocked Telegram download.
        const streaming = pipeline(source, meter, uploadBody, { signal }).catch((error: unknown) => {
          const failure = classifyMediaError(error, 'telegram');
          firstFailure ??= failure;
          controller.abort();
          throw failure;
        });
        const uploading = storage.put(job, uploadBody, download.size, signal).catch((error: unknown) => {
          const failure = classifyMediaError(error, 's3');
          firstFailure ??= failure;
          controller.abort();
          throw failure;
        });
        const settled = await Promise.allSettled([streaming, uploading]);
        const rejected = settled.filter(item => item.status === 'rejected');
        if (rejected.length) {
          // Prefer an explicit S3/limit error over secondary pipeline AbortError.
          const primary = rejected.find(item => item.reason instanceof MediaError &&
            !['TELEGRAM_NETWORK', 'S3_NETWORK'].includes(item.reason.code));
          throw primary?.reason ?? firstFailure;
        }
        result = { ...meter.result(), etag: (settled[1] as PromiseFulfilledResult<string | null>).value };
      }
    }
    stage = 'database';
    await repository.complete(job, result);
    logger.info({ event: 'media_archived', media_id: job.id, size: result.size, duration_ms: Date.now() - started });
    return true;
  } catch (error) {
    controller.abort();
    const failure = options.signal.aborted ? new MediaError('INTERRUPTED', true) : classifyMediaError(error, stage);
    const next = options.signal.aborted ? new Date() : retryAt(failure, job.attempt_count, config.MEDIA_MAX_ATTEMPTS);
    await repository.failure(job, failure.code, next, options.signal.aborted);
    logger.warn({ event: next ? 'media_retry' : 'media_failed', media_id: job.id,
      code: failure.code, attempt_count: job.attempt_count, retry_at: next?.toISOString() ?? null });
    return false;
  } finally {
    source?.destroy();
    if (tempDirectory) {
      // Only the known temporary file and its empty directory; never recursive deletion.
      await unlink(join(tempDirectory, 'payload')).catch(() => {});
      await rmdir(tempDirectory).catch(() => {});
    }
  }
}
