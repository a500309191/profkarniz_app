import { sql, type Kysely } from 'kysely';
import { normalizeUpdate, type TelegramUpdate } from '../telegram/normalize.js';
import type { Database } from './types.js';

// Telegram may randomize update_id after a week without updates. An expired
// cursor is omitted, asking for the earliest unconfirmed update (never negative).
export const CURSOR_TTL_MS = 6 * 24 * 60 * 60 * 1000;

export interface Cursor { offset: number | undefined; lastUpdateAt: number | null }
export interface BatchResult { inserted: number; duplicates: number; messages: number; cursor: Cursor }
export interface UpdateStore {
  loadCursor(): Promise<Cursor>;
  saveBatch(updates: TelegramUpdate[]): Promise<BatchResult>;
}

export class TelegramStore implements UpdateStore {
  constructor(private readonly db: Kysely<Database>, private readonly botId: string) {}

  async loadCursor(): Promise<Cursor> {
    const state = await this.db.selectFrom('telegram_polling_state')
      .selectAll().where('bot_id', '=', this.botId).executeTakeFirst();
    return { offset: state ? Number(state.next_offset) : undefined,
      lastUpdateAt: state?.last_update_at.getTime() ?? null };
  }

  async saveBatch(updates: TelegramUpdate[]): Promise<BatchResult> {
    if (updates.length === 0) throw new Error('EMPTY_BATCH');
    return this.db.transaction().execute(async trx => {
      let inserted = 0;
      let messages = 0;
      for (const update of updates) {
        const normalized = normalizeUpdate(update);
        const raw = await trx.insertInto('telegram_updates').values({
          bot_id: this.botId, update_id: String(update.update_id),
          update_type: normalized.updateType, raw_update: JSON.stringify(update)
        }).onConflict(conflict => conflict.columns(['bot_id', 'update_id']).doNothing())
          .returning('id').executeTakeFirst();
        if (!raw) continue;
        inserted++;
        const fields = normalized.message;
        if (!fields) continue;
        const identity = { bot_id: this.botId, chat_id: fields.chat_id,
          message_id: fields.message_id, context_key: fields.context_key };
        let message = await trx.insertInto('telegram_messages')
          .values({ ...identity, first_update_id: raw.id })
          .onConflict(conflict => conflict.columns(['bot_id', 'chat_id', 'message_id', 'context_key']).doNothing())
          .returning('id').executeTakeFirst();
        message ??= await trx.selectFrom('telegram_messages').select('id')
          .where('bot_id', '=', identity.bot_id).where('chat_id', '=', identity.chat_id)
          .where('message_id', '=', identity.message_id).where('context_key', '=', identity.context_key)
          .executeTakeFirstOrThrow();
        const { chat_id: _chat, message_id: _message, context_key: _context, ...event } = fields;
        void _chat; void _message; void _context;
        await trx.insertInto('telegram_message_events').values({
          ...event,
          telegram_message_id: message.id,
          telegram_update_id: raw.id,
          update_type: normalized.updateType,
          sender_chat: JSON.stringify(event.sender_chat),
          forward_metadata: JSON.stringify(event.forward_metadata),
          attachments: JSON.stringify(event.attachments)
        }).execute();
        messages++;
      }
      const nextOffset = Math.max(...updates.map(update => update.update_id)) + 1;
      const state = await trx.insertInto('telegram_polling_state').values({
        bot_id: this.botId, next_offset: String(nextOffset), last_update_at: new Date()
      }).onConflict(conflict => conflict.column('bot_id').doUpdateSet({
        next_offset: String(nextOffset), last_update_at: sql`now()`
      })).returning('last_update_at').executeTakeFirstOrThrow();
      return { inserted, duplicates: updates.length - inserted, messages,
        cursor: { offset: nextOffset, lastUpdateAt: state.last_update_at.getTime() } };
    });
  }
}
