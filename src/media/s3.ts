import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { S3Config } from './config.js';
import type { ArchiveStorage, MediaJob } from './types.js';
import { MediaError } from './errors.js';
import { hashStream } from './streams.js';

export function createS3Client(config: S3Config) {
  return new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE === 'true',
    credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY },
    // The durable worker owns retries; a consumed request stream is not replayable.
    maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 60_000 },
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  });
}

export class S3Archive implements ArchiveStorage {
  constructor(private readonly client: S3Client) {}
  async head(job: MediaJob, signal: AbortSignal) {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: job.s3_bucket, Key: job.s3_key }), { abortSignal: signal });
      if (result.ContentLength === undefined) throw new MediaError('S3_INVALID_RESPONSE', true);
      return { size: result.ContentLength, archiveId: result.Metadata?.['archive-id'] ?? null, etag: result.ETag ?? null };
    } catch (error) {
      if (typeof error === 'object' && error !== null && '$metadata' in error &&
        (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 404) return null;
      throw error;
    }
  }
  async get(job: MediaJob, signal: AbortSignal) {
    const result = await this.client.send(new GetObjectCommand({ Bucket: job.s3_bucket, Key: job.s3_key }), { abortSignal: signal });
    if (!(result.Body instanceof Readable)) throw new MediaError('S3_INVALID_RESPONSE', true);
    return result.Body;
  }
  async put(job: MediaJob, body: Readable, size: number, signal: AbortSignal) {
    const result = await this.client.send(new PutObjectCommand({ Bucket: job.s3_bucket, Key: job.s3_key,
      Body: body, ContentLength: size, ContentType: job.mime_type ?? 'application/octet-stream',
      Metadata: { 'archive-id': job.id }, IfNoneMatch: '*'
      // No ACL, public URL, multipart upload or object deletion.
    }), { abortSignal: signal });
    return result.ETag ?? null;
  }
}

export type S3CheckOperation = 'ListObjectsV2' | 'PutObject' | 'HeadObject' | 'GetObject';

export async function checkS3Access(client: S3Client, bucket: string, signal: AbortSignal,
  onOperation?: (operation: S3CheckOperation) => void) {
  onOperation?.('ListObjectsV2');
  await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'test/', MaxKeys: 1 }), { abortSignal: signal });
  const key = `test/access-check-${randomUUID()}.txt`;
  const body = Buffer.from('ProfKarniz S3 access check\n');
  onOperation?.('PutObject');
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body,
    ContentLength: body.length, ContentType: 'text/plain', IfNoneMatch: '*' }), { abortSignal: signal });
  onOperation?.('HeadObject');
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
  if (head.ContentLength !== body.length) throw new MediaError('S3_CHECK_SIZE_MISMATCH', false);
  onOperation?.('GetObject');
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
  if (!(result.Body instanceof Readable)) throw new MediaError('S3_INVALID_RESPONSE', true);
  const actual = await hashStream(result.Body, 1024, body.length, signal);
  const expected = await hashStream(Readable.from([body]), 1024, body.length, signal);
  if (actual.sha256 !== expected.sha256) throw new MediaError('S3_CHECK_HASH_MISMATCH', false);
  return key; // Technical object deliberately remains in test/; no DeleteObject.
}
