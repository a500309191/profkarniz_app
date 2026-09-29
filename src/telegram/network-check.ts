import { lookup } from 'node:dns/promises';
import { Agent } from 'undici';
import { networkErrorCodes, telegramConnectOptions, TELEGRAM_ORIGIN } from './transport.js';

// Token-free diagnostic: HEAD / only, no bot methods, no redirects to other sites.
try {
  const addresses = await lookup(new URL(TELEGRAM_ORIGIN).hostname,
    { all: true, family: 0, hints: 0, order: 'ipv6first' });
  process.stdout.write(`${JSON.stringify({ node: process.version, addresses })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ dns: 'failed', codes: networkErrorCodes(error) })}\n`);
}

const results = await Promise.all(([4, 6, 0] as const).map(async family => {
  const connect = family === 0 ? telegramConnectOptions() : {
    family, autoSelectFamily: false, timeout: 10_000, rejectUnauthorized: true
  };
  const dispatcher = new Agent({ connect });
  const mode = family === 0 ? 'ipv6first-with-fallback' : `ipv${family}-only`;
  const start = Date.now();
  try {
    const options = { method: 'HEAD', redirect: 'manual' as const,
      signal: AbortSignal.timeout(12_000), dispatcher };
    const response = await fetch(`${TELEGRAM_ORIGIN}/`, options);
    await response.body?.cancel();
    process.stdout.write(`${JSON.stringify({ mode, reachable: true, status: response.status, elapsed_ms: Date.now() - start })}\n`);
    return { family, reachable: true };
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ mode, reachable: false, codes: networkErrorCodes(error), elapsed_ms: Date.now() - start })}\n`);
    return { family, reachable: false };
  } finally {
    await dispatcher.destroy();
  }
}));
if (!results.find(result => result.family === 0)?.reachable) process.exitCode = 1;
