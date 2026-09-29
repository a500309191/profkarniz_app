import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { CURSOR_TTL_MS, type BatchResult, type UpdateStore } from '../../src/db/store.js';
import { collect, verifyTelegram, type CollectorState } from '../../src/telegram/collector.js';
import { TelegramError, type TelegramApi } from '../../src/telegram/client.js';
import { textUpdate } from '../fixtures.js';

const logger = pino({ level: 'silent' });
const saved: BatchResult = { inserted: 1, duplicates: 0, messages: 1,
  cursor: { offset: 102, lastUpdateAt: Date.now() } };
const initialState = (): CollectorState => ({ phase: 'starting', lastSuccessAt: null, lastError: null });

describe('startup network failures', () => {
  it('retries transient getMe/getWebhookInfo failures instead of exiting the process', async () => {
    const state = initialState();
    const api = { verifyIdentity: vi.fn()
      .mockRejectedValueOnce(new TelegramError('NETWORK', 0, ['ENETUNREACH']))
      .mockResolvedValueOnce('123') };
    const sleep = vi.fn(async (ms: number) => {
      expect(ms).toBeGreaterThanOrEqual(1000);
      expect(state).toMatchObject({ phase: 'retrying', lastError: 'telegram' });
    });
    expect(await verifyTelegram({ api, state, signal: new AbortController().signal, logger, sleep })).toBe('123');
    expect(api.verifyIdentity).toHaveBeenCalledTimes(2);
    expect(state).toMatchObject({ phase: 'starting', lastError: null });
  });

  it('respects rate limits and cancels retry on shutdown', async () => {
    const controller = new AbortController();
    const api = { verifyIdentity: vi.fn().mockRejectedValue(new TelegramError(429, 60)) };
    const sleep = vi.fn(async (ms: number) => {
      expect(ms).toBeGreaterThanOrEqual(60_000);
      controller.abort();
    });
    expect(await verifyTelegram({ api, state: initialState(), signal: controller.signal, logger, sleep })).toBeNull();
    expect(api.verifyIdentity).toHaveBeenCalledOnce();
  });

  it.each([401, 409])('retains fail-fast handling for configuration error %s', async code => {
    await expect(verifyTelegram({ api: { verifyIdentity: async () => { throw new TelegramError(code); } },
      state: initialState(), signal: new AbortController().signal, logger })).rejects.toMatchObject({ code });
  });
});

describe('durable polling', () => {
  it('does not advance offset when saving fails and advances only after commit', async () => {
    const stop = new AbortController();
    const offsets: (number | undefined)[] = [];
    const state = initialState();
    const api: TelegramApi = { getUpdates: vi.fn(async offset => {
      offsets.push(offset);
      if (offsets.length === 3) { stop.abort(); return []; }
      return [textUpdate];
    }) };
    const store: UpdateStore = {
      loadCursor: async () => ({ offset: 101, lastUpdateAt: Date.now() }),
      saveBatch: vi.fn().mockRejectedValueOnce(new Error('commit failed')).mockResolvedValueOnce(saved)
    };
    await collect({ api, store, state, signal: stop.signal, logger,
      assertLeadership: async () => {}, sleep: async () => {} });
    expect(offsets).toEqual([101, 101, 102]);
    expect(store.saveBatch).toHaveBeenCalledTimes(2);
    expect(state.lastError).toBeNull();
  });

  it('honors Telegram retry_after and reports temporary failure', async () => {
    const stop = new AbortController();
    const state = initialState();
    const sleep = vi.fn(async (ms: number) => {
      expect(ms).toBeGreaterThanOrEqual(45_000);
      expect(state.phase).toBe('retrying');
      stop.abort();
    });
    await collect({ api: { getUpdates: async () => { throw new TelegramError(429, 45); } },
      store: { loadCursor: async () => ({ offset: undefined, lastUpdateAt: null }), saveBatch: vi.fn() },
      state, signal: stop.signal, logger, assertLeadership: async () => {}, sleep });
    expect(sleep).toHaveBeenCalledOnce();
    expect(state.lastError).toBe('telegram');
  });

  it.each([401, 409])('fails visibly for Telegram %s', async code => {
    const state = initialState();
    await expect(collect({ api: { getUpdates: async () => { throw new TelegramError(code); } },
      store: { loadCursor: async () => ({ offset: undefined, lastUpdateAt: null }), saveBatch: vi.fn() },
      state, signal: new AbortController().signal, logger, assertLeadership: async () => {} }))
      .rejects.toBeInstanceOf(TelegramError);
    expect(state.phase).toBe('failed');
  });

  it('resumes from persisted cursor after restart', async () => {
    const stop = new AbortController();
    const getUpdates = vi.fn(async () => { stop.abort(); return []; });
    await collect({ api: { getUpdates }, store: {
      loadCursor: async () => ({ offset: 9001, lastUpdateAt: Date.now() }), saveBatch: vi.fn()
    }, state: initialState(), signal: stop.signal, logger, assertLeadership: async () => {} });
    expect(getUpdates).toHaveBeenCalledWith(9001, stop.signal);
  });

  it('omits stale cursor so randomized update IDs are not skipped', async () => {
    const stop = new AbortController();
    const getUpdates = vi.fn(async () => { stop.abort(); return []; });
    await collect({ api: { getUpdates }, store: {
      loadCursor: async () => ({ offset: 99999, lastUpdateAt: 1 }), saveBatch: vi.fn()
    }, state: initialState(), signal: stop.signal, logger, assertLeadership: async () => {},
    now: () => CURSOR_TTL_MS + 2 });
    expect(getUpdates).toHaveBeenCalledWith(undefined, stop.signal);
  });

  it('does not poll after leadership is lost', async () => {
    const stop = new AbortController();
    const getUpdates = vi.fn();
    await collect({ api: { getUpdates }, store: {
      loadCursor: async () => ({ offset: 1, lastUpdateAt: 1 }), saveBatch: vi.fn()
    }, state: initialState(), signal: stop.signal, logger,
    assertLeadership: async () => { stop.abort(); } });
    expect(getUpdates).not.toHaveBeenCalled();
  });
});
