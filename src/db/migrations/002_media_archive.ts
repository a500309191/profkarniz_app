import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE telegram_media_objects (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      bot_id bigint NOT NULL,
      telegram_message_event_id bigint NOT NULL REFERENCES telegram_message_events(id),
      attachment_index integer NOT NULL CHECK (attachment_index >= 0),
      telegram_file_id text NOT NULL,
      telegram_file_unique_id text,
      media_type text NOT NULL,
      original_filename text,
      mime_type text,
      telegram_reported_size bigint CHECK (telegram_reported_size >= 0),
      downloaded_size bigint CHECK (downloaded_size >= 0),
      sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      s3_endpoint text NOT NULL,
      s3_bucket text NOT NULL,
      s3_key text NOT NULL,
      s3_etag text,
      archive_status text NOT NULL DEFAULT 'pending'
        CHECK (archive_status IN ('pending', 'downloading', 'uploading', 'archived', 'failed')),
      archived_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      last_error_code text,
      attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      lease_until timestamptz,
      attempt_token uuid,
      UNIQUE (telegram_message_event_id, attachment_index),
      UNIQUE (s3_endpoint, s3_bucket, s3_key),
      CHECK (archive_status <> 'archived' OR (downloaded_size IS NOT NULL AND sha256 IS NOT NULL AND archived_at IS NOT NULL)),
      CHECK ((archive_status IN ('downloading', 'uploading')) = (attempt_token IS NOT NULL AND lease_until IS NOT NULL))
    );
    CREATE INDEX telegram_media_ready_idx ON telegram_media_objects(bot_id, next_attempt_at, id)
      WHERE archive_status = 'pending';
    CREATE INDEX telegram_media_lease_idx ON telegram_media_objects(bot_id, lease_until)
      WHERE archive_status IN ('downloading', 'uploading');
    CREATE INDEX telegram_media_status_idx ON telegram_media_objects(bot_id, archive_status);
    CREATE TABLE telegram_media_discovery (
      bot_id bigint PRIMARY KEY,
      last_event_id bigint NOT NULL CHECK (last_event_id >= 0)
    );
  `.execute(db);
}
