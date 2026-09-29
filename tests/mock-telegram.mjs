// Loaded only by the Linux process integration test. No network calls to Telegram.
import { setTimeout } from 'node:timers/promises';
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith('https://api.telegram.org/')) return originalFetch(url, options);
  const method = String(url).split('/').at(-1);
  let result;
  if (method === 'getMe') result = { id: 80001, is_bot: true };
  else if (method === 'getWebhookInfo') result = { url: '' };
  else if (method === 'getUpdates') {
    const body = JSON.parse(options.body);
    if (body.offset === undefined) result = [{ update_id: 901,
      message: { message_id: 1, chat: { id: -100 }, date: 1750000000, text: 'private mock message' } }];
    else { await setTimeout(1000, undefined, { signal: options.signal }); result = []; }
  } else throw new Error('Unexpected Telegram method');
  return new globalThis.Response(JSON.stringify({ ok: true, result }));
};
