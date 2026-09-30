import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import pino from 'pino';
import { expect, it, vi } from 'vitest';
import { archiveJob } from '../../src/media/archive.js';
import { createS3Client, S3Archive, checkS3Access } from '../../src/media/s3.js';
import { mediaConfig, mediaJob } from '../media-fixtures.js';

it('streams single private conditional PUTs through AWS SDK and reconciles a lost upload acknowledgement', async () => {
  const objects = new Map<string, { data: Buffer; id: string | undefined }>();
  const requests: { method: string; path: string; headers: IncomingHttpHeaders }[] = [];
  let dropNextPutResponse = false;
  let failureStatus = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, 'http://localhost');
      requests.push({ method: req.method!, path: url.pathname, headers: req.headers });
      if (failureStatus) { res.writeHead(failureStatus); res.end('<Error><Code>AccessDenied</Code></Error>'); return; }
      if (url.searchParams.has('list-type')) { res.end('<ListBucketResult><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>'); return; }
      const stored = objects.get(url.pathname);
      if (req.method === 'PUT') {
        if (stored && req.headers['if-none-match'] === '*') { res.writeHead(412); res.end(); return; }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        objects.set(url.pathname, { data: Buffer.concat(chunks), id: req.headers['x-amz-meta-archive-id'] as string | undefined });
        if (dropNextPutResponse) { dropNextPutResponse = false; res.destroy(); return; }
        res.setHeader('etag', '"mock-etag"'); res.end(); return;
      }
      if (!stored) { res.writeHead(404); res.end(); return; }
      res.setHeader('content-length', stored.data.length);
      res.setHeader('etag', '"mock-etag"');
      if (stored.id) res.setHeader('x-amz-meta-archive-id', stored.id);
      res.end(req.method === 'GET' ? stored.data : undefined);
    })().catch(() => res.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP address required');
  const config = { ...mediaConfig, s3: { ...mediaConfig.s3, S3_ENDPOINT: `http://127.0.0.1:${address.port}` } };
  const client = createS3Client(config.s3);
  const storage = new S3Archive(client);
  const job = mediaJob({ s3_endpoint: config.s3.S3_ENDPOINT });
  const signal = new AbortController().signal;
  const repository = { uploading: vi.fn(async () => {}), complete: vi.fn(async () => {}), failure: vi.fn(async () => {}) };
  const files = { download: vi.fn(async () => ({ body: Readable.from([Buffer.from('abc'), Buffer.from('def')]), size: 6 })) };
  try {
    dropNextPutResponse = true;
    const options = { job, repository, files, storage, config, signal, logger: pino({ level: 'silent' }) };
    expect(await archiveJob(options)).toBe(false);
    expect(repository.failure).toHaveBeenCalledWith(job, 'S3_NETWORK', expect.any(Date), false);
    expect(await archiveJob(options)).toBe(true);
    expect(files.download).toHaveBeenCalledTimes(1);
    expect(objects.get(`/${job.s3_bucket}/${job.s3_key}`)?.data.toString()).toBe('abcdef');
    expect(requests.map(r => r.method)).toEqual(['HEAD', 'PUT', 'HEAD', 'GET']);
    const put = requests.find(r => r.method === 'PUT')!;
    expect(put.headers['content-length']).toBe('6');
    expect(put.headers['if-none-match']).toBe('*');
    expect(put.headers['x-amz-acl']).toBeUndefined();
    expect(put.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);

    const key = await checkS3Access(client, job.s3_bucket, signal);
    expect(key).toMatch(/^test\/access-check-[a-f0-9-]+\.txt$/);
    expect(objects.has(`/${job.s3_bucket}/${key}`)).toBe(true);
    expect(requests.every(r => ['HEAD', 'GET', 'PUT'].includes(r.method))).toBe(true);

    failureStatus = 403;
    await expect(storage.head(job, signal)).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
    failureStatus = 503;
    const count = requests.length;
    await expect(storage.head(job, signal)).rejects.toMatchObject({ $metadata: { httpStatusCode: 503 } });
    expect(requests.length - count).toBe(1); // Durable queue, not SDK, owns retries.
  } finally {
    client.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
