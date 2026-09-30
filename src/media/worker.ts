import type { Logger } from 'pino';
import type { EnabledMediaConfig } from './config.js';
import type { MediaRepository } from './repository.js';
import type { ArchiveStorage, MediaHealth, TelegramFiles } from './types.js';
import { archiveJob } from './archive.js';
import { pause } from '../telegram/collector.js';

export async function runMediaWorker(options: {
  repository: MediaRepository; files: TelegramFiles; storage: ArchiveStorage;
  config: EnabledMediaConfig; state: MediaHealth; signal: AbortSignal; logger: Logger;
  assertLeadership: () => Promise<void>;
}) {
  const { repository, config, state, signal, logger, assertLeadership } = options;
  const active = new Set<Promise<void>>();
  while (!signal.aborted) {
    try {
      await assertLeadership();
      if (signal.aborted) break;
      await repository.recover();
      const found = await repository.discover();
      if (found.inserted) logger.info({ event: 'media_discovered', count: found.inserted });
      while (!signal.aborted && active.size < config.MEDIA_CONCURRENCY) {
        const job = await repository.claim();
        if (!job) break;
        const task = archiveJob({ ...options, job }).then(() => {}).catch(() => {
          state.status = 'degraded';
          state.last_error_code = 'MEDIA_DATABASE';
          logger.error({ event: 'media_retry', media_id: job.id, code: 'MEDIA_DATABASE' });
          // An unrecorded outcome is recovered by lease expiry or next startup.
        }).finally(() => { active.delete(task); });
        active.add(task);
      }
      const stats = await repository.stats();
      state.pending = stats.pending;
      state.failed = stats.failed;
      state.status = stats.errors ? 'degraded' : 'ok';
      state.last_error_code = stats.errors ? 'MEDIA_JOBS_REQUIRE_RETRY' : null;
      state.last_scan_at = new Date().toISOString();
    } catch {
      if (signal.aborted) break;
      state.status = 'degraded';
      state.last_error_code = 'MEDIA_DATABASE';
      logger.error({ event: 'media_retry', code: 'MEDIA_DATABASE' });
    }
    await pause(1000, signal);
  }
  await Promise.all(active);
}
