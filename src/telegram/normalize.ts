export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type TelegramUpdate = JsonObject & { update_id: number };

export interface Attachment {
  type: string;
  path: string;
  file_id: string;
  file_unique_id: string | null;
  metadata: JsonObject;
}

export function object(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject : null;
}

const string = (value: Json | undefined): string | null => typeof value === 'string' ? value : null;
const id = (value: Json | undefined): string | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
const date = (value: Json | undefined): Date | null => {
  if (typeof value !== 'number') return null;
  const result = new Date(value * 1000);
  return Number.isFinite(result.getTime()) ? result : null;
};

const messageKeys = ['message', 'edited_message', 'channel_post', 'edited_channel_post',
  'business_message', 'edited_business_message', 'guest_message'] as const;
const mediaKeys = ['photo', 'document', 'video', 'voice', 'audio', 'animation', 'sticker',
  'video_note', 'paid_media', 'live_photo', 'story', 'rich_message'] as const;

// Keep all file variants and thumbnails, including metadata unknown to this version.
// Only inspect this message's media, not files from nested replies/forward origins.
function collectFiles(value: Json | undefined, type: string, path: string, result: Attachment[]) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectFiles(item, type, `${path}.${index}`, result));
    return;
  }
  const record = object(value);
  if (!record) return;
  if (typeof record.file_id === 'string') {
    result.push({ type, path, file_id: record.file_id,
      file_unique_id: string(record.file_unique_id), metadata: record });
  }
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === 'object') collectFiles(child, type, `${path}.${key}`, result);
  }
}

export function normalizeUpdate(update: TelegramUpdate) {
  const key = messageKeys.find(candidate => object(update[candidate]) !== null);
  const updateType = key ?? Object.keys(update).find(candidate => candidate !== 'update_id') ?? 'unknown';
  const message = key ? object(update[key]) : null;
  const chat = object(message?.chat);
  const chatId = id(chat?.id);
  const messageId = id(message?.message_id);
  if (!message || !chatId || !messageId) return { updateType, message: null };

  const sender = object(message.from);
  const reply = object(message.reply_to_message);
  const attachments: Attachment[] = [];
  for (const type of mediaKeys) collectFiles(message[type], type, type, attachments);
  const presentMedia = mediaKeys.filter(type => message[type] !== undefined);
  const contentTypes = ['contact', 'location', 'venue', 'poll', 'dice', 'game', 'invoice'];
  const messageType = presentMedia[0] ?? (typeof message.text === 'string' ? 'text' :
    contentTypes.find(type => message[type] !== undefined) ?? 'service_or_unknown');
  const forward: JsonObject = {};
  for (const [field, value] of Object.entries(message)) {
    if (field.startsWith('forward_') || field === 'is_automatic_forward') forward[field] = value;
  }
  return {
    updateType,
    message: {
      chat_id: chatId,
      message_id: messageId,
      // Separate business namespaces if Telegram supplies a connection identifier.
      context_key: string(message.business_connection_id) ?? '',
      sender_user_id: id(sender?.id),
      username: string(sender?.username),
      first_name: string(sender?.first_name),
      last_name: string(sender?.last_name),
      sender_chat: object(message.sender_chat),
      sent_at: date(message.date),
      edited_at: date(message.edit_date),
      text: string(message.text),
      caption: string(message.caption),
      reply_to_message_id: id(reply?.message_id),
      media_group_id: string(message.media_group_id),
      message_thread_id: id(message.message_thread_id),
      forward_metadata: Object.keys(forward).length > 0 ? forward : null,
      message_type: messageType,
      attachments
    }
  };
}

export type NormalizedMessage = NonNullable<ReturnType<typeof normalizeUpdate>['message']>;
