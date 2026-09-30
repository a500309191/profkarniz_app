import { Readable } from 'node:stream';
import type { EnabledMediaConfig } from '../src/media/config.js';
import type { ArchiveStorage, MediaJob } from '../src/media/types.js';

export const mediaConfig: EnabledMediaConfig = {
  enabled: true, MEDIA_CONCURRENCY: 2, MEDIA_MAX_ATTEMPTS: 5,
  MEDIA_JOB_TIMEOUT_SECONDS: 10, MEDIA_MAX_FILE_BYTES: 20 * 1024 * 1024,
  s3: { S3_ENDPOINT: 'https://s3.example.test', S3_REGION: 'test', S3_BUCKET: 'archive-test',
    S3_ACCESS_KEY_ID: 'test-access', S3_SECRET_ACCESS_KEY: 'test-secret' }
};
export function mediaJob(overrides: Partial<MediaJob> = {}): MediaJob {
  return { id: '1', bot_id: '123', telegram_message_event_id: '7', attachment_index: 0,
    telegram_file_id: 'file', telegram_file_unique_id: 'unique', media_type: 'document',
    original_filename: null, mime_type: null, telegram_reported_size: null,
    downloaded_size: null, sha256: null, s3_endpoint: mediaConfig.s3.S3_ENDPOINT,
    s3_bucket: mediaConfig.s3.S3_BUCKET, s3_key: 'telegram/123/-10/2026/09/2/events/7/0-unique.bin',
    s3_etag: null, archive_status: 'downloading', archived_at: null, created_at: new Date(),
    updated_at: new Date(), last_error_code: null, attempt_count: 1, next_attempt_at: new Date(),
    lease_until: new Date(Date.now() + 60_000), attempt_token: '00000000-0000-4000-8000-000000000001', ...overrides };
}

// Small fixtures only. Production never collects the whole body in memory.
export class MemoryArchive implements ArchiveStorage {
  objects = new Map<string, { data: Buffer; archiveId: string }>();
  puts = 0;
  async head(job: MediaJob) {
    const stored = this.objects.get(job.s3_key);
    return stored ? { size: stored.data.length, archiveId: stored.archiveId, etag: 'test-etag' } : null;
  }
  async get(job: MediaJob) { return Readable.from([this.objects.get(job.s3_key)!.data]); }
  async put(job: MediaJob, body: Readable) {
    this.puts++;
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
    this.objects.set(job.s3_key, { data: Buffer.concat(chunks), archiveId: job.id });
    return 'test-etag';
  }
}
