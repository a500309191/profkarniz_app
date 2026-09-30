import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/types.js';
import type { EnabledMediaConfig } from './config.js';
import { discoverAttachments, extension, objectKey } from './discovery.js';
import type { ArchiveResult, MediaJob } from './types.js';

type DB = Kysely<Database> | Transaction<Database>;
export class MediaRepository {
  constructor(private readonly db: Kysely<Database>, readonly botId: string,
    private readonly config: EnabledMediaConfig) {}

  private events(db: DB) {
    return db.selectFrom('telegram_message_events as e')
      .innerJoin('telegram_messages as m', 'm.id', 'e.telegram_message_id')
      .where('m.bot_id', '=', this.botId);
  }

  async initialize() {
    const max = await this.events(this.db).select(eb => eb.fn.max<string>('e.id').as('id')).executeTakeFirstOrThrow();
    await this.db.insertInto('telegram_media_discovery').values({ bot_id: this.botId, last_event_id: max.id ?? '0' })
      .onConflict(c => c.column('bot_id').doNothing()).execute();
    // Caller holds the existing bot advisory lock. Resume only previously queued work.
    await this.recover(true);
  }

  private async discoverPage(db: DB, after: string, through?: string) {
    let query = this.events(db).select(['e.id', 'e.attachments', 'e.sent_at', 'e.created_at', 'm.chat_id', 'm.message_id'])
      .where('e.id', '>', after).orderBy('e.id').limit(100);
    if (through !== undefined) query = query.where('e.id', '<=', through);
    const events = await query.execute();
    let inserted = 0;
    for (const event of events) {
      for (const { index, attachment } of discoverAttachments(event.attachments)) {
        const filename = typeof attachment.metadata.file_name === 'string' ? attachment.metadata.file_name : null;
        const mime = typeof attachment.metadata.mime_type === 'string' ? attachment.metadata.mime_type : null;
        const size = attachment.metadata.file_size;
        const key = objectKey({ botId: this.botId, chatId: event.chat_id, messageId: event.message_id,
          eventId: event.id, date: event.sent_at ?? event.created_at, index, fileUniqueId: attachment.file_unique_id,
          fileId: attachment.file_id, ext: extension(filename, mime) });
        const row = await db.insertInto('telegram_media_objects').values({
          bot_id: this.botId, telegram_message_event_id: event.id, attachment_index: index,
          telegram_file_id: attachment.file_id, telegram_file_unique_id: attachment.file_unique_id,
          media_type: attachment.type, original_filename: filename, mime_type: mime,
          telegram_reported_size: typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? String(size) : null,
          s3_endpoint: this.config.s3.S3_ENDPOINT, s3_bucket: this.config.s3.S3_BUCKET, s3_key: key,
          downloaded_size: null, sha256: null, s3_etag: null, archived_at: null,
          last_error_code: null, lease_until: null, attempt_token: null
        }).onConflict(c => c.columns(['telegram_message_event_id', 'attachment_index']).doNothing())
          .returning('id').executeTakeFirst();
        if (row) inserted++;
      }
    }
    return { inserted, scanned: events.length, lastId: events.at(-1)?.id ?? after };
  }

  async discover() {
    return this.db.transaction().execute(async trx => {
      const cursor = await trx.selectFrom('telegram_media_discovery').select('last_event_id')
        .where('bot_id', '=', this.botId).forUpdate().executeTakeFirstOrThrow();
      const result = await this.discoverPage(trx, cursor.last_event_id);
      await trx.updateTable('telegram_media_discovery').set({ last_event_id: result.lastId })
        .where('bot_id', '=', this.botId).execute();
      return result;
    });
  }

  async backfill(signal: AbortSignal) {
    const max = await this.events(this.db).select(eb => eb.fn.max<string>('e.id').as('id')).executeTakeFirstOrThrow();
    let after = '0';
    let inserted = 0;
    while (!signal.aborted) {
      const result = await this.db.transaction().execute(trx => this.discoverPage(trx, after, max.id ?? '0'));
      inserted += result.inserted;
      after = result.lastId;
      if (result.scanned < 100) break;
    }
    return inserted;
  }

  async recover(all = false) {
    let query = this.db.updateTable('telegram_media_objects').set({ archive_status: 'pending',
      attempt_token: null, lease_until: null, next_attempt_at: new Date(), updated_at: new Date(), last_error_code: 'INTERRUPTED' })
      .where('bot_id', '=', this.botId).where('archive_status', 'in', ['downloading', 'uploading']);
    if (!all) query = query.where('lease_until', '<', new Date());
    await query.execute();
  }

  async claim(): Promise<MediaJob | undefined> {
    return this.db.transaction().execute(async trx => {
      const job = await trx.selectFrom('telegram_media_objects').selectAll()
        .where('bot_id', '=', this.botId).where('archive_status', '=', 'pending')
        .where('next_attempt_at', '<=', new Date()).orderBy('next_attempt_at').orderBy('id')
        .forUpdate().skipLocked().limit(1).executeTakeFirst();
      if (!job) return undefined;
      return trx.updateTable('telegram_media_objects').set({ archive_status: 'downloading',
        attempt_count: job.attempt_count + 1, attempt_token: randomUUID(), updated_at: new Date(),
        lease_until: new Date(Date.now() + (this.config.MEDIA_JOB_TIMEOUT_SECONDS + 60) * 1000) })
        .where('id', '=', job.id).returningAll().executeTakeFirstOrThrow();
    });
  }

  private owned(job: MediaJob) {
    return this.db.updateTable('telegram_media_objects').where('id', '=', job.id)
      .where('bot_id', '=', this.botId).where('attempt_token', '=', job.attempt_token);
  }
  async uploading(job: MediaJob) {
    const result = await this.owned(job).set({ archive_status: 'uploading', updated_at: new Date() }).executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Error('MEDIA_LEASE_LOST');
  }
  async complete(job: MediaJob, result: ArchiveResult) {
    const updated = await this.owned(job).set({ archive_status: 'archived', downloaded_size: String(result.size),
      sha256: result.sha256, s3_etag: result.etag, archived_at: new Date(), updated_at: new Date(),
      last_error_code: null, attempt_token: null, lease_until: null }).executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) throw new Error('MEDIA_LEASE_LOST');
  }
  async failure(job: MediaJob, code: string, retryAt: Date | null, interrupted = false) {
    await this.owned(job).set({ archive_status: retryAt ? 'pending' : 'failed', last_error_code: code,
      next_attempt_at: retryAt ?? new Date(), updated_at: new Date(), attempt_token: null, lease_until: null,
      ...(interrupted ? { attempt_count: Math.max(0, job.attempt_count - 1) } : {}) }).execute();
  }
  async retryFailed() {
    const result = await this.db.updateTable('telegram_media_objects').set({ archive_status: 'pending',
      attempt_count: 0, last_error_code: null, next_attempt_at: new Date(), updated_at: new Date() })
      .where('bot_id', '=', this.botId).where('archive_status', '=', 'failed').executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
  async stats() {
    const rows = await this.db.selectFrom('telegram_media_objects')
      .select(['archive_status', sql<string>`count(*)`.as('count'),
        sql<string>`count(*) FILTER (WHERE last_error_code IS NOT NULL)`.as('errors')]).where('bot_id', '=', this.botId)
      .where('archive_status', 'in', ['pending', 'downloading', 'uploading', 'failed'])
      .groupBy('archive_status').execute();
    return { pending: rows.filter(row => ['pending', 'downloading', 'uploading'].includes(row.archive_status))
      .reduce((sum, row) => sum + Number(row.count), 0),
    failed: Number(rows.find(row => row.archive_status === 'failed')?.count ?? 0),
    errors: rows.reduce((sum, row) => sum + Number(row.errors), 0) };
  }
}
