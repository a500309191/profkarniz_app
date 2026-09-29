import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE telegram_updates (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      bot_id bigint NOT NULL,
      update_id bigint NOT NULL,
      update_type text NOT NULL,
      raw_update jsonb NOT NULL CHECK (jsonb_typeof(raw_update) = 'object'),
      received_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (bot_id, update_id)
    );
    CREATE TABLE telegram_messages (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      bot_id bigint NOT NULL,
      chat_id bigint NOT NULL,
      message_id bigint NOT NULL,
      context_key text NOT NULL DEFAULT '',
      first_update_id bigint NOT NULL REFERENCES telegram_updates(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (bot_id, chat_id, message_id, context_key)
    );
    CREATE TABLE telegram_message_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      telegram_message_id bigint NOT NULL REFERENCES telegram_messages(id),
      telegram_update_id bigint NOT NULL UNIQUE REFERENCES telegram_updates(id),
      update_type text NOT NULL,
      sender_user_id bigint,
      username text,
      first_name text,
      last_name text,
      sender_chat jsonb,
      sent_at timestamptz,
      edited_at timestamptz,
      text text,
      caption text,
      reply_to_message_id bigint,
      media_group_id text,
      message_thread_id bigint,
      forward_metadata jsonb,
      message_type text NOT NULL,
      attachments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments) = 'array'),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX telegram_messages_chat_idx ON telegram_messages(bot_id, chat_id, message_id);
    CREATE INDEX telegram_events_message_idx ON telegram_message_events(telegram_message_id, id);
    CREATE INDEX telegram_events_album_idx ON telegram_message_events(media_group_id)
      WHERE media_group_id IS NOT NULL;
    CREATE INDEX telegram_events_sent_at_idx ON telegram_message_events(sent_at);
    CREATE TABLE telegram_polling_state (
      bot_id bigint PRIMARY KEY,
      next_offset bigint NOT NULL CHECK (next_offset >= 0),
      last_update_at timestamptz NOT NULL
    );
    CREATE FUNCTION reject_telegram_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'Telegram history is append-only' USING ERRCODE = '55000';
    END;
    $$;
    CREATE TRIGGER telegram_updates_immutable
      BEFORE UPDATE OR DELETE OR TRUNCATE ON telegram_updates
      FOR EACH STATEMENT EXECUTE FUNCTION reject_telegram_history_mutation();
    CREATE TRIGGER telegram_events_immutable
      BEFORE UPDATE OR DELETE OR TRUNCATE ON telegram_message_events
      FOR EACH STATEMENT EXECUTE FUNCTION reject_telegram_history_mutation();
  `.execute(db);
}

// Intentionally no down(): rollback of this milestone must never drop source data.
