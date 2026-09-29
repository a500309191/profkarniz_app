import type { ColumnType, Generated } from 'kysely';
import type { JsonObject, NormalizedMessage } from '../telegram/normalize.js';

type BigId = ColumnType<string, string, never>;
type JsonColumn<T> = ColumnType<T, string, never>;

export interface Database {
  telegram_updates: {
    id: Generated<string>;
    bot_id: BigId;
    update_id: BigId;
    update_type: string;
    raw_update: JsonColumn<JsonObject>;
    received_at: Generated<Date>;
  };
  telegram_messages: {
    id: Generated<string>;
    bot_id: BigId;
    chat_id: BigId;
    message_id: BigId;
    context_key: string;
    first_update_id: BigId;
    created_at: Generated<Date>;
  };
  telegram_message_events: Omit<NormalizedMessage,
    'chat_id' | 'message_id' | 'context_key' | 'attachments' | 'forward_metadata' | 'sender_chat'> & {
    id: Generated<string>;
    telegram_message_id: BigId;
    telegram_update_id: BigId;
    update_type: string;
    sender_chat: JsonColumn<NormalizedMessage['sender_chat']>;
    forward_metadata: JsonColumn<NormalizedMessage['forward_metadata']>;
    attachments: JsonColumn<NormalizedMessage['attachments']>;
    created_at: Generated<Date>;
  };
  telegram_polling_state: {
    bot_id: string;
    next_offset: string;
    last_update_at: Date;
  };
}
