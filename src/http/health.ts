import { createServer } from 'node:http';
import type { CollectorState } from '../telegram/collector.js';
import type { MediaHealth } from '../media/types.js';

export function createHealthServer(options: {
  state: CollectorState;
  staleSeconds: number;
  checkDatabase: () => Promise<void>;
  now?: () => number;
  media?: MediaHealth;
}) {
  const now = options.now ?? Date.now;
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/health') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"not_found"}');
      return;
    }
    void (async () => {
      let database = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          options.checkDatabase(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('HEALTH_TIMEOUT')), 2000);
          })
        ]);
        database = true;
      } catch { /* Return status only: DB errors can contain credentials. */ }
      finally { clearTimeout(timer); }
      const state = options.state;
      const polling = state.phase === 'running' && state.lastSuccessAt !== null &&
        now() - state.lastSuccessAt < options.staleSeconds * 1000;
      const healthy = database && polling;
      response.writeHead(healthy ? 200 : 503, {
        'content-type': 'application/json', 'cache-control': 'no-store'
      });
      response.end(JSON.stringify({ status: healthy ? 'ok' : 'unavailable',
        database: database ? 'up' : 'down',
        ...(options.media ? { media_archive: { ...options.media,
          status: options.media.status !== 'disabled' && (!options.media.last_scan_at ||
            now() - Date.parse(options.media.last_scan_at) > 30_000) ? 'degraded' : options.media.status } } : {}),
        collector: { phase: state.phase, healthy: polling,
          last_success_at: state.lastSuccessAt === null ? null : new Date(state.lastSuccessAt).toISOString(),
          last_error: state.lastError } }));
    })();
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return server;
}
