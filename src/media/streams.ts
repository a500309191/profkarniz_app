import { createHash } from 'node:crypto';
import { Transform, Writable, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MediaError } from './errors.js';

export class HashAndCount extends Transform {
  size = 0;
  private readonly hash = createHash('sha256');
  private digest: string | undefined;
  constructor(private readonly maxBytes: number, private readonly expectedSize: number | null = null) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.size += chunk.length;
    if (this.size > this.maxBytes) return callback(new MediaError('MEDIA_TOO_LARGE', false));
    if (this.expectedSize !== null && this.size > this.expectedSize) return callback(new MediaError('MEDIA_SIZE_MISMATCH', true));
    this.hash.update(chunk);
    callback(null, chunk);
  }
  override _flush(callback: TransformCallback) {
    if (this.expectedSize !== null && this.size !== this.expectedSize) return callback(new MediaError('MEDIA_SIZE_MISMATCH', true));
    this.digest = this.hash.digest('hex');
    callback();
  }
  result() {
    if (!this.digest) throw new MediaError('MEDIA_INCOMPLETE_STREAM', true);
    return { size: this.size, sha256: this.digest };
  }
}

export async function hashStream(body: Readable, maxBytes: number, expectedSize: number | null, signal: AbortSignal) {
  const meter = new HashAndCount(maxBytes, expectedSize);
  await pipeline(body, meter, new Writable({ write(_chunk, _encoding, callback) { callback(); } }), { signal });
  return meter.result();
}
