import type { TelegramUpdate } from '../src/telegram/normalize.js';

export const textUpdate: TelegramUpdate = {
  update_id: 101,
  message: {
    message_id: 51, date: 1_750_000_000,
    chat: { id: -1_001_234_567_890, type: 'supergroup', title: 'Test group' },
    from: { id: 123_456_789, is_bot: false, username: 'tester', first_name: 'Тест', last_name: 'Пользователь' },
    text: 'Тестовое сообщение', entities: [{ type: 'bold', offset: 0, length: 8 }]
  }
};
