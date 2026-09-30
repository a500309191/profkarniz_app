import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { readS3Config } from '../../src/media/config.js';
import { classifyMediaError, s3ErrorDetails } from '../../src/media/errors.js';
import { checkS3Access, createS3Client, type S3CheckOperation } from '../../src/media/s3.js';
import { mediaConfig } from '../media-fixtures.js';

const operations: S3CheckOperation[] = ['ListObjectsV2', 'PutObject', 'HeadObject', 'GetObject'];
const signal = new AbortController().signal;

function mockS3(forcePathStyle: 'true' | 'false', deny?: S3CheckOperation) {
  const config = { ...mediaConfig.s3, S3_ENDPOINT: 'https://s3.ru-7.storage.selcloud.ru',
    S3_BUCKET: 'profkarniz-storage', S3_REGION: 'ru-7', S3_FORCE_PATH_STYLE: forcePathStyle };
  const client = createS3Client(config);
  const requests: { hostname: string; path: string; method: string; protocol: string }[] = [];
  let stored = Buffer.alloc(0);
  // Intercept only the HTTP transport. Real SDK endpoint resolution, signing,
  // serialization and deserialization still run; no DNS or Selectel access.
  vi.spyOn(client.config.requestHandler, 'handle').mockImplementation(async request => {
    const operation = operations[requests.length]!;
    requests.push({ hostname: request.hostname, path: request.path, method: request.method, protocol: request.protocol });
    expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(request.headers['x-amz-acl']).toBeUndefined();
    expect(request.headers['host']).toBe(request.hostname);
    if (operation === deny) return { response: { statusCode: 403, headers: {},
      body: Readable.from(['<Error><Code>AccessDenied</Code><Message>private diagnostic details</Message></Error>']) } };
    if (operation === 'ListObjectsV2') {
      expect(request.query).toMatchObject({ 'list-type': '2', prefix: 'test/', 'max-keys': '1' });
      return { response: { statusCode: 200, headers: {},
        body: Readable.from(['<ListBucketResult><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>']) } };
    }
    if (operation === 'PutObject') {
      expect(request.headers['if-none-match']).toBe('*');
      stored = Buffer.from(request.body as Uint8Array);
    }
    return { response: { statusCode: 200, headers: { 'content-length': String(stored.length) },
      body: Readable.from(operation === 'GetObject' ? [stored] : []) } };
  });
  return { client, requests, bucket: config.S3_BUCKET };
}

describe('S3 addressing and check diagnostics', () => {
  it('keeps existing addressing by default and validates an explicit opt-in to virtual hosting', () => {
    expect(readS3Config({ ...mediaConfig.s3, S3_FORCE_PATH_STYLE: undefined }).S3_FORCE_PATH_STYLE).toBe('true');
    expect(readS3Config({ ...mediaConfig.s3, S3_FORCE_PATH_STYLE: 'false' }).S3_FORCE_PATH_STYLE).toBe('false');
    expect(() => readS3Config({ ...mediaConfig.s3, S3_FORCE_PATH_STYLE: 'yes' })).toThrow('S3_FORCE_PATH_STYLE');
  });

  it.each(['true', 'false'] as const)('signs all four requests with the correct host/path (forcePathStyle=%s)', async style => {
    const { client, requests, bucket } = mockS3(style);
    const steps: S3CheckOperation[] = [];
    try {
      const key = await checkS3Access(client, bucket, signal, operation => steps.push(operation));
      expect(steps).toEqual(operations);
      expect(requests.map(request => request.method)).toEqual(['GET', 'PUT', 'HEAD', 'GET']);
      const pathPrefix = style === 'true' ? '/profkarniz-storage' : '';
      expect(requests.map(request => request.path)).toEqual([`${pathPrefix}/`, ...Array(3).fill(`${pathPrefix}/${key}`)]);
      expect(requests.every(request => request.protocol === 'https:')).toBe(true);
      expect(requests.every(request => request.hostname === (style === 'true' ? 's3.ru-7.storage.selcloud.ru' : 'profkarniz-storage.s3.ru-7.storage.selcloud.ru'))).toBe(true);
    } finally { client.destroy(); }
  });

  it.each(operations)('identifies AccessDenied on %s and stops before the next operation', async denied => {
    const { client, requests, bucket } = mockS3('false', denied);
    const steps: S3CheckOperation[] = [];
    try {
      const result = await checkS3Access(client, bucket, signal, operation => steps.push(operation))
        .catch((error: unknown) => ({ operation: steps.at(-1), code: classifyMediaError(error, 's3').code, ...s3ErrorDetails(error) }));
      expect(result).toMatchObject({ operation: denied, code: 'S3_ACCESS_DENIED', http_status: 403 });
      if (denied !== 'HeadObject') expect(result).toMatchObject({ s3_code: 'AccessDenied' });
      expect(requests).toHaveLength(operations.indexOf(denied) + 1);
      expect(JSON.stringify(result)).not.toContain('private');
    } finally { client.destroy(); }
  });

  it('distinguishes signature failures from AccessDenied while refusing arbitrary SDK diagnostics', () => {
    expect(s3ErrorDetails({ name: 'SignatureDoesNotMatch', message: 'secret', $metadata: { httpStatusCode: 403 } }))
      .toEqual({ http_status: 403, s3_code: 'SignatureDoesNotMatch' });
    expect(s3ErrorDetails({ name: 'https://private.test/?signature=secret', $metadata: { httpStatusCode: 'secret' } }))
      .toEqual({ http_status: null, s3_code: null });
    expect(s3ErrorDetails(null)).toEqual({ http_status: null, s3_code: null });
  });
});
