import { getDefaultResultOrder, lookup } from 'node:dns';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { getDefaultAutoSelectFamily, type LookupFunction } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from 'undici';
import { createTelegramDispatcher, createTelegramLookup, networkErrorCodes,
  telegramConnectOptions } from '../../src/telegram/transport.js';

const servers: Server[] = [];
const agents: Agent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map(agent => agent.destroy()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function listen(host: string, ipv6Only = false) {
  const server = createServer((request, response) => {
    response.end(request.socket.localAddress);
  });
  servers.push(server);
  server.listen({ host, port: 0, ipv6Only });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return address.port;
}

async function request(port: number, addresses: LookupAddress[]) {
  const resolve: LookupFunction = (hostname, options, callback) => {
    expect(hostname).toBe('telegram-transport.test');
    // This is Node's real net.connect asking for all addresses for auto-selection.
    expect(options.all).toBe(true);
    callback(null, addresses);
  };
  const dispatcher = createTelegramDispatcher(resolve);
  agents.push(dispatcher);
  const options = { dispatcher, signal: AbortSignal.timeout(3000) };
  const response = await fetch(`http://telegram-transport.test:${port}/`, options);
  return response.text();
}

describe('Telegram-only DNS/connection policy', () => {
  it('asks the OS resolver for both families, IPv6 first, without ADDRCONFIG filtering', () => {
    const callback = vi.fn();
    const records = [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }];
    const resolve = vi.fn<LookupFunction>((_hostname, _options, done) => done(null, records));
    createTelegramLookup(resolve)('api.telegram.org', { all: true, family: 0, hints: 32 }, callback);
    expect(resolve).toHaveBeenCalledWith('api.telegram.org', {
      all: true, family: 0, hints: 0, order: 'ipv6first'
    }, callback);
    expect(callback).toHaveBeenCalledWith(null, records);
  });

  it('preserves single-result lookup callback semantics', () => {
    const callback = vi.fn();
    const resolve = vi.fn<LookupFunction>((_hostname, _options, done) => done(null, '::1', 6));
    createTelegramLookup(resolve)('api.telegram.org', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '::1', 6);
    expect(resolve.mock.calls[0]?.[1].all).toBeUndefined();
  });

  it('uses Node 24 native IPv6-first ordering for the local resolver', async () => {
    const result = await new Promise<LookupAddress[]>((resolve, reject) => {
      lookup('localhost', { all: true, hints: 0, order: 'ipv6first' }, (error, addresses) => {
        if (error) reject(error); else resolve(addresses);
      });
    });
    const firstV4 = result.findIndex(address => address.family === 4);
    const lastV6 = result.findLastIndex(address => address.family === 6);
    if (firstV4 !== -1 && lastV6 !== -1) expect(lastV6).toBeLessThan(firstV4);
    expect(result.length).toBeGreaterThan(0);
  });

  it('keeps TLS verification and bounded address-family fallback without changing globals', () => {
    const order = getDefaultResultOrder();
    const automatic = getDefaultAutoSelectFamily();
    const originalFetch = globalThis.fetch;
    agents.push(createTelegramDispatcher());
    expect(telegramConnectOptions()).toMatchObject({ family: 0, autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250, timeout: 10_000, rejectUnauthorized: true });
    expect(telegramConnectOptions()).not.toHaveProperty('servername');
    expect(telegramConnectOptions()).not.toHaveProperty('checkServerIdentity');
    expect(getDefaultResultOrder()).toBe(order);
    expect(getDefaultAutoSelectFamily()).toBe(automatic);
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it('reports only known error codes, never nested URLs or arbitrary code values', () => {
    const sensitive = 'https://api.telegram.org/bot123:PRIVATE/getMe';
    const error = new Error(sensitive, { cause: new AggregateError([
      Object.assign(new Error(sensitive), { code: 'ENETUNREACH' }),
      { code: sensitive }, { code: 'ETIMEDOUT' }
    ]) });
    expect(networkErrorCodes(error)).toEqual(['ENETUNREACH', 'ETIMEDOUT']);
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(networkErrorCodes(cyclic)).toEqual([]);
  });
});

// Real Node fetch + Undici Agent + local sockets. No Telegram, DNS or public IPs.
describe('real dual-stack connections', () => {
  it('prefers IPv6 when both families work', async () => {
    const port = await listen('::');
    expect(await request(port, [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }])).toBe('::1');
  });

  it('succeeds over IPv6 when the server has no IPv4 listener', async () => {
    const port = await listen('::1', true);
    expect(await request(port, [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }])).toBe('::1');
  });

  it('falls back to IPv4 if the IPv6 connection fails', async () => {
    const port = await listen('127.0.0.1');
    expect(await request(port, [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }])).toBe('127.0.0.1');
  });

  it('works when DNS has only IPv4', async () => {
    const port = await listen('127.0.0.1');
    expect(await request(port, [{ address: '127.0.0.1', family: 4 }])).toBe('127.0.0.1');
  });

  it('works when DNS has only IPv6', async () => {
    const port = await listen('::1', true);
    expect(await request(port, [{ address: '::1', family: 6 }])).toBe('::1');
  });
});
