import { describe, expect, it } from 'vitest';
import { normalizeUpdate, type JsonObject } from '../../src/telegram/normalize.js';
import { textUpdate } from '../fixtures.js';

describe('Telegram update normalization', () => {
  it('projects sender, safe bigint identifiers, timestamp and text without mutating input', () => {
    const before = structuredClone(textUpdate);
    const result = normalizeUpdate(textUpdate);
    expect(result.updateType).toBe('message');
    expect(result.message).toMatchObject({ chat_id: '-1001234567890', message_id: '51',
      sender_user_id: '123456789', username: 'tester', first_name: 'Тест',
      last_name: 'Пользователь', text: 'Тестовое сообщение', message_type: 'text', attachments: [] });
    expect(result.message?.sent_at?.getTime()).toBe(1_750_000_000_000);
    expect(textUpdate).toEqual(before);
  });

  it('accepts missing optional fields and anonymous sender_chat', () => {
    const result = normalizeUpdate({ update_id: 1, message: {
      message_id: 2, date: 1_750_000_000, chat: { id: -100 },
      sender_chat: { id: -100, title: 'Anonymous admin' }, new_chat_title: 'New name'
    } });
    expect(result.message).toMatchObject({ sender_user_id: null, username: null, first_name: null,
      last_name: null, text: null, caption: null, reply_to_message_id: null, media_group_id: null,
      forward_metadata: null, edited_at: null, message_type: 'service_or_unknown', attachments: [],
      sender_chat: { id: -100, title: 'Anonymous admin' } });
  });

  it('keeps all photo sizes, caption, album, reply and forward metadata', () => {
    const result = normalizeUpdate({ update_id: 102, message: {
      ...textUpdate.message as JsonObject, text: null, caption: 'Подпись', media_group_id: 'album-1',
      photo: [{ file_id: 'small', file_unique_id: 'u1', width: 90, height: 90 },
        { file_id: 'large', file_unique_id: 'u2', width: 1000, height: 1000, file_size: 45000 }],
      reply_to_message: { message_id: 40, photo: [{ file_id: 'reply-file' }] },
      forward_origin: { type: 'hidden_user', sender_user_name: 'Hidden', date: 100 },
      is_automatic_forward: true, message_thread_id: 3
    } });
    expect(result.message).toMatchObject({ caption: 'Подпись', media_group_id: 'album-1',
      reply_to_message_id: '40', message_thread_id: '3', message_type: 'photo',
      forward_metadata: { forward_origin: { type: 'hidden_user' }, is_automatic_forward: true } });
    expect(result.message?.attachments.map(file => file.file_id)).toEqual(['small', 'large']);
    expect(result.message?.attachments[1]?.metadata.file_size).toBe(45000);
  });

  it.each(['document', 'video', 'voice', 'audio', 'animation', 'sticker', 'video_note'])(
    'keeps %s file metadata and thumbnail', type => {
      const result = normalizeUpdate({ update_id: 103, message: {
        message_id: 2, chat: { id: -100 }, date: 100,
        [type]: { file_id: 'main', file_unique_id: 'unique', mime_type: 'example/type',
          file_name: 'test.dat', duration: 7, future_field: 'kept',
          thumbnail: { file_id: 'thumb', file_unique_id: 'ut', width: 90 } }
      } });
      expect(result.message?.message_type).toBe(type);
      expect(result.message?.attachments).toHaveLength(2);
      expect(result.message?.attachments[0]).toMatchObject({ file_id: 'main', file_unique_id: 'unique',
        metadata: { file_name: 'test.dat', future_field: 'kept', duration: 7 } });
    });

  it.each(['edited_message', 'channel_post', 'edited_channel_post', 'business_message', 'edited_business_message'])(
    'recognizes %s updates', type => {
      expect(normalizeUpdate({ update_id: 104, [type]: textUpdate.message! }).updateType).toBe(type);
    });

  it('keeps legacy forwarding fields', () => {
    const result = normalizeUpdate({ update_id: 1, message: { ...textUpdate.message as JsonObject,
      forward_from: { id: 33 }, forward_from_chat: { id: -3 }, forward_from_message_id: 12,
      forward_signature: 'Author', forward_date: 100 } });
    expect(result.message?.forward_metadata).toMatchObject({ forward_from: { id: 33 }, forward_signature: 'Author' });
  });

  it('accepts non-message updates and future shapes for raw storage', () => {
    expect(normalizeUpdate({ update_id: 105, future_event: { value: 'keep' } }))
      .toEqual({ updateType: 'future_event', message: null });
    expect(normalizeUpdate({ update_id: 106, message: { future: true } }).message).toBeNull();
  });
});
