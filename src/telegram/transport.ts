import { lookup } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent } from 'undici';

export const TELEGRAM_ORIGIN = 'https://api.telegram.org';

export function createTelegramLookup(resolve: LookupFunction = lookup): LookupFunction {
  return (hostname, options, callback) => {
    // Keep the OS resolver (/etc/hosts, Docker DNS, etc.), but ask for both
    // families, IPv6 first. Do not inherit net's implicit ADDRCONFIG filter.
    resolve(hostname, { ...options, family: 0, hints: 0, order: 'ipv6first' }, callback);
  };
}

export function telegramConnectOptions(resolve = createTelegramLookup()) {
  return {
    lookup: resolve,
    family: 0,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
    timeout: 10_000,
    rejectUnauthorized: true
  };
}

export function createTelegramDispatcher(resolve = createTelegramLookup()) {
  // Per-client dispatcher: no global DNS, fetch, PostgreSQL or OS changes.
  // URL hostname is retained, so Undici supplies api.telegram.org as TLS SNI
  // and Node verifies its certificate against that hostname as usual.
  return new Agent({ connect: telegramConnectOptions(resolve) });
}

const safeNetworkCodes = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'
]);

// Error messages/causes may include the secret Bot API URL. Only retain codes
// from this fixed allowlist, including errors from Node's family auto-selection.
export function networkErrorCodes(error: unknown): string[] {
  const codes = new Set<string>();
  function visit(value: unknown, depth: number) {
    if (depth > 4 || typeof value !== 'object' || value === null) return;
    if ('code' in value && typeof value.code === 'string' && safeNetworkCodes.has(value.code)) codes.add(value.code);
    if ('cause' in value) visit(value.cause, depth + 1);
    if (value instanceof AggregateError) for (const item of value.errors) visit(item, depth + 1);
  }
  visit(error, 0);
  return [...codes];
}
