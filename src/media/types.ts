import type { Generated, Selectable } from 'kysely';
import type { Readable } from 'node:stream';

export type ArchiveStatus = 'pending' | 'downloading' | 'uploading' | 'archived' | 'failed';
export interface MediaObjectTable {
  id: Generated<string>;
  bot_id: string;
  telegram_message_event_id: string;
  attachment_index: number;
  telegram_file_id: string;
  telegram_file_unique_id: string | null;
  media_type: string;
  original_filename: string | null;
  mime_type: string | null;
  telegram_reported_size: string | null;
  downloaded_size: string | null;
  sha256: string | null;
  s3_endpoint: string;
  s3_bucket: string;
  s3_key: string;
  s3_etag: string | null;
  archive_status: Generated<ArchiveStatus>;
  archived_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  last_error_code: string | null;
  attempt_count: Generated<number>;
  next_attempt_at: Generated<Date>;
  lease_until: Date | null;
  attempt_token: string | null;
}
export type MediaJob = Selectable<MediaObjectTable>;
export interface ArchiveResult { size: number; sha256: string; etag: string | null }
export interface MediaHealth {
  status: 'disabled' | 'ok' | 'degraded';
  pending: number;
  failed: number;
  last_scan_at: string | null;
  last_error_code: string | null;
}
export interface FileDownload { body: Readable; size: number | null }
export interface TelegramFiles {
  download(fileId: string, signal: AbortSignal, maxBytes: number): Promise<FileDownload>;
}
export interface ObjectHead { size: number; archiveId: string | null; etag: string | null }
export interface ArchiveStorage {
  head(job: MediaJob, signal: AbortSignal): Promise<ObjectHead | null>;
  get(job: MediaJob, signal: AbortSignal): Promise<Readable>;
  put(job: MediaJob, body: Readable, size: number, signal: AbortSignal): Promise<string | null>;
}
