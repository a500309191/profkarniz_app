import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createHealthServer } from '../../src/http/health.js';
import type { CollectorState } from '../../src/telegram/collector.js';
import type { MediaHealth } from '../../src/media/types.js';

async function check(state: CollectorState, databaseUp = true, path = '/health', media?: MediaHealth) {
  const server = createHealthServer({ state, staleSeconds: 120, now: () => 200_000,
    ...(media ? { media } : {}), checkDatabase: async () => { if (!databaseUp) throw new Error('sensitive database detail'); } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('/health', () => {
  const running: CollectorState = { phase: 'running', lastSuccessAt: 190_000, lastError: null };
  it('returns 200 only with a database and recent successful polling', async () => {
    expect(await check(running)).toMatchObject({ status: 200, body: { status: 'ok', database: 'up' } });
  });
  it('returns 503 for a disconnected database without leaking errors', async () => {
    const result = await check(running, false);
    expect(result).toMatchObject({ status: 503, body: { database: 'down' } });
    expect(JSON.stringify(result)).not.toContain('sensitive');
  });
  it.each(['starting', 'retrying', 'failed', 'stopping'] as const)('returns 503 while %s', async phase => {
    expect((await check({ ...running, phase })).status).toBe(503);
  });
  it('returns 503 for stalled polling', async () => {
    expect((await check({ ...running, lastSuccessAt: 1 })).status).toBe(503);
  });
  it('returns 404 outside /health', async () => {
    expect((await check(running, true, '/messages')).status).toBe(404);
  });
  it('reports cached media degradation separately without affecting healthy polling', async () => {
    expect(await check(running, true, '/health', { status: 'degraded', pending: 3, failed: 1,
      last_scan_at: new Date(195_000).toISOString(), last_error_code: 'MEDIA_JOBS_REQUIRE_RETRY' }))
      .toMatchObject({ status: 200, body: { status: 'ok', media_archive: { status: 'degraded', pending: 3, failed: 1 } } });
    expect(await check(running, true, '/health', { status: 'ok', pending: 0, failed: 0,
      last_scan_at: null, last_error_code: null }))
      .toMatchObject({ status: 200, body: { media_archive: { status: 'degraded' } } });
    expect(await check(running, true, '/health', { status: 'disabled', pending: 0, failed: 0,
      last_scan_at: null, last_error_code: null }))
      .toMatchObject({ status: 200, body: { media_archive: { status: 'disabled' } } });
  });
});
