import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { archiveJob } from '../../src/media/archive.js';
import { readMediaConfig, TELEGRAM_DOWNLOAD_LIMIT } from '../../src/media/config.js';
import { discoverAttachments, extension, objectKey } from '../../src/media/discovery.js';
import { classifyMediaError, MediaError, retryAt } from '../../src/media/errors.js';
import { hashStream } from '../../src/media/streams.js';
import { TelegramError } from '../../src/telegram/client.js';
import { normalizeUpdate } from '../../src/telegram/normalize.js';
import { textUpdate } from '../fixtures.js';
import { mediaConfig, mediaJob, MemoryArchive } from '../media-fixtures.js';

const signal = new AbortController().signal;
const logger = pino({ level: 'silent' });
const content = Buffer.from('binary\0fixture\xff');
const digest = createHash('sha256').update(content).digest('hex');

describe('media configuration and discovery', () => {
  it('requires no S3 config when disabled and validates all five fields only when enabled', () => {
    expect(readMediaConfig({})).toEqual({ enabled: false });
    expect(readMediaConfig({ MEDIA_ARCHIVE_ENABLED: 'false', S3_ENDPOINT: 'invalid' })).toEqual({ enabled: false });
    for (const name of Object.keys(mediaConfig.s3)) {
      expect(() => readMediaConfig({ ...mediaConfig.s3, [name]: '', MEDIA_ARCHIVE_ENABLED: 'true' })).toThrow(name);
    }
    expect(readMediaConfig({ ...mediaConfig.s3, MEDIA_ARCHIVE_ENABLED: 'true' })).toMatchObject({ enabled: true, MEDIA_CONCURRENCY: 2 });
    expect(() => readMediaConfig({ ...mediaConfig.s3, MEDIA_ARCHIVE_ENABLED: 'true', MEDIA_CONCURRENCY: '99' })).toThrow('MEDIA_CONCURRENCY');
    expect(() => readMediaConfig({ ...mediaConfig.s3, MEDIA_ARCHIVE_ENABLED: 'true', MEDIA_MAX_FILE_BYTES: String(TELEGRAM_DOWNLOAD_LIMIT + 1) })).toThrow('MEDIA_MAX_FILE_BYTES');
    expect(() => readMediaConfig({ MEDIA_ARCHIVE_ENABLED: 'yes' })).toThrow('MEDIA_ARCHIVE_ENABLED');
  });

  it('rejects endpoints containing credentials, query strings, paths or insecure transport without leaking values', () => {
    for (const endpoint of ['http://example.test', 'https://user:secret@example.test', 'https://example.test/path', 'https://example.test?secret=value']) {
      try { readMediaConfig({ ...mediaConfig.s3, MEDIA_ARCHIVE_ENABLED: 'true', S3_ENDPOINT: endpoint }); throw new Error('expected rejection'); }
      catch (error) { expect(String(error)).toContain('S3_ENDPOINT'); expect(String(error)).not.toContain('secret'); }
    }
  });

  it.each([
    ['../../private\\invoice.PDF', 'image/jpeg', 'pdf'],
    ['bad.ext?query', 'application/pdf; charset=utf-8', 'pdf'],
    ['file.bad_extension', 'unknown/type', 'bin'],
    [null, 'audio/mpeg', 'mp3'], [null, null, 'bin']
  ])('selects a safe extension for %s', (filename, mime, expected) => {
    expect(extension(filename, mime)).toBe(expected);
  });

  it('generates deterministic keys while separating events, messages and hostile identities', () => {
    const input = { botId: '123', chatId: '-10', messageId: '2', eventId: '7',
      date: new Date('2026-09-30T23:00:00Z'), index: 0, fileUniqueId: 'unique', fileId: 'file', ext: 'pdf' };
    expect(objectKey(input)).toBe('telegram/123/-10/2026/09/2/events/7/0-unique.pdf');
    expect(objectKey(input)).toBe(objectKey({ ...input }));
    expect(objectKey({ ...input, eventId: '8' })).not.toBe(objectKey(input));
    expect(objectKey({ ...input, messageId: '3' })).not.toBe(objectKey(input));
    const unsafe = objectKey({ ...input, fileUniqueId: '../../secret?token=value' });
    expect(unsafe).toMatch(/\/0-[a-f0-9]{64}\.pdf$/);
    expect(unsafe).not.toContain('secret');
    expect(() => objectKey({ ...input, ext: '../pdf' })).toThrow();
    expect(() => objectKey({ ...input, chatId: '../10' })).toThrow();
    expect(objectKey({ ...input, fileUniqueId: null })).toMatch(/\/0-[a-f0-9]{64}\.pdf$/);
  });

  it('chooses one largest photo, ignores thumbnails/unsupported types and retains original metadata', () => {
    const attachments = [
      { type: 'photo', path: 'photo.0', file_id: 'small', file_unique_id: 's', metadata: { width: 10, height: 10, file_size: 50 } },
      { type: 'photo', path: 'photo.1', file_id: 'large', file_unique_id: 'l', metadata: { width: 100, height: 100, file_size: 1000 } },
      { type: 'photo', path: 'photo.2', file_id: 'large2', file_unique_id: 'l2', metadata: { width: 100, height: 100, file_size: 2000 } },
      ...['document', 'video', 'voice', 'audio', 'animation', 'video_note', 'sticker'].map(type =>
        ({ type, path: type, file_id: type, file_unique_id: type, metadata: {} })),
      { type: 'photo', path: 'video.thumbnail', file_id: 'thumb', file_unique_id: 'thumb', metadata: { width: 200, height: 200 } }
    ];
    const snapshot = structuredClone(attachments);
    const found = discoverAttachments(attachments);
    expect(found.map(item => item.attachment.file_id)).toEqual(['large2', 'document', 'video', 'voice', 'audio', 'animation', 'video_note']);
    expect(found[0]!.index).toBe(2);
    expect(attachments).toEqual(snapshot);
  });

  it('handles normalized paths and deduplicates the animation document alias', () => {
    const normalized = normalizeUpdate({ ...textUpdate, message: {
      ...(textUpdate.message as object), photo: [{ file_id: 'p', file_unique_id: 'p', width: 100, height: 100 }],
      animation: { file_id: 'a', file_unique_id: 'a' }, document: { file_id: 'a', file_unique_id: 'a' }
    } });
    expect(discoverAttachments(normalized.message!.attachments).map(item => item.attachment.type)).toEqual(['photo', 'animation']);
  });
});

describe('bounded streaming and retries', () => {
  it('hashes incrementally and verifies length', async () => {
    expect(await hashStream(Readable.from([content.subarray(0, 3), content.subarray(3)]), 100, content.length, signal))
      .toEqual({ size: content.length, sha256: digest });
    await expect(hashStream(Readable.from([content]), 2, null, signal)).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });
    await expect(hashStream(Readable.from([content]), 100, 99, signal)).rejects.toMatchObject({ code: 'MEDIA_SIZE_MISMATCH' });
  });

  it('classifies network/rate/permanent failures and bounds retries with jitter', () => {
    const rate = classifyMediaError(new TelegramError(429, 20), 'telegram');
    expect(rate).toMatchObject({ code: 'TELEGRAM_RATE_LIMIT', retryable: true });
    expect(retryAt(rate, 1, 5, 1000, () => 0)?.getTime()).toBe(21_000);
    expect(retryAt(new MediaError('S3_NETWORK', true), 3, 5, 0, () => 0)?.getTime()).toBe(10_000);
    expect(retryAt(new MediaError('S3_NETWORK', true), 3, 5, 0, () => 1)?.getTime()).toBe(30_000);
    expect(retryAt(rate, 5, 5)).toBeNull();
    expect(classifyMediaError(new TelegramError(400), 'telegram')).toMatchObject({ code: 'TELEGRAM_FILE_UNAVAILABLE', retryable: false });
    expect(classifyMediaError({ $metadata: { httpStatusCode: 503 } }, 's3')).toMatchObject({ code: 'S3_UNAVAILABLE', retryable: true });
    const denied = classifyMediaError({ $metadata: { httpStatusCode: 403 } }, 's3');
    expect(denied.code).toBe('S3_ACCESS_DENIED');
    expect(retryAt(denied, 1, 5)).toBeNull();
  });
});

function scenario() {
  return { job: mediaJob(), config: mediaConfig, signal, logger, storage: new MemoryArchive(),
    files: { download: vi.fn(async () => ({ body: Readable.from([content.subarray(0, 3), content.subarray(3)]), size: content.length as number | null })) },
    repository: { uploading: vi.fn(async () => {}), complete: vi.fn(async () => {}), failure: vi.fn(async () => {}) } };
}

describe('archive execution', () => {
  it.each([false, true])('archives exact bytes and SHA-256 (unknown length: %s)', async unknown => {
    const options = scenario();
    if (unknown) options.files.download.mockImplementation(async () => ({ body: Readable.from([content]), size: null }));
    expect(await archiveJob(options)).toBe(true);
    expect(options.storage.objects.get(options.job.s3_key)?.data).toEqual(content);
    expect(options.repository.complete).toHaveBeenCalledWith(options.job, { size: content.length, sha256: digest, etag: 'test-etag' });
    expect(options.repository.failure).not.toHaveBeenCalled();
  });

  it('recovers an uploaded object after a failed database completion without another Telegram download or PUT', async () => {
    const options = scenario();
    options.repository.complete.mockRejectedValueOnce(new Error('sensitive database error'));
    expect(await archiveJob(options)).toBe(false);
    expect(options.repository.failure).toHaveBeenCalledWith(options.job, 'MEDIA_DATABASE', expect.any(Date), false);
    options.files.download.mockClear();
    expect(await archiveJob(options)).toBe(true);
    expect(options.files.download).not.toHaveBeenCalled();
    expect(options.storage.puts).toBe(1);
  });

  it('never overwrites an unrelated object at the same key', async () => {
    const options = scenario();
    options.storage.objects.set(options.job.s3_key, { data: content, archiveId: 'another-job' });
    expect(await archiveJob(options)).toBe(false);
    expect(options.repository.failure).toHaveBeenCalledWith(options.job, 'S3_IDENTITY_MISMATCH', null, false);
    expect(options.files.download).not.toHaveBeenCalled();
  });

  it.each([503, 403])('persists S3 %s as retry or terminal failure and cancels its input stream', async status => {
    const options = scenario();
    vi.spyOn(options.storage, 'put').mockRejectedValue({ $metadata: { httpStatusCode: status } });
    expect(await archiveJob(options)).toBe(false);
    expect(options.repository.failure).toHaveBeenCalledWith(options.job, status === 503 ? 'S3_UNAVAILABLE' : 'S3_ACCESS_DENIED', status === 503 ? expect.any(Date) : null, false);
    expect(options.repository.complete).not.toHaveBeenCalled();
  });

  it('attributes an early S3 connection failure to S3 rather than the cancelled Telegram stream', async () => {
    const options = scenario();
    options.files.download.mockImplementation(async () => ({ body: new Readable({ read() {} }), size: 3 }));
    vi.spyOn(options.storage, 'put').mockRejectedValue(new Error('private signed endpoint'));
    expect(await archiveJob(options)).toBe(false);
    expect(options.repository.failure).toHaveBeenCalledWith(options.job, 'S3_NETWORK', expect.any(Date), false);
  });

  it.each([400, 429, 'NETWORK'] as const)('persists Telegram %s without uploading', async code => {
    const options = scenario();
    options.files.download.mockRejectedValue(new TelegramError(code, 30));
    expect(await archiveJob(options)).toBe(false);
    expect(options.storage.puts).toBe(0);
    expect(options.repository.failure.mock.calls[0]).toEqual([options.job,
      code === 400 ? 'TELEGRAM_FILE_UNAVAILABLE' : code === 429 ? 'TELEGRAM_RATE_LIMIT' : 'TELEGRAM_NETWORK',
      code === 400 ? null : expect.any(Date), false]);
  });

  it('rejects oversize/truncated streams without marking archived', async () => {
    const options = scenario();
    options.files.download.mockImplementation(async () => ({ body: Readable.from([content]), size: content.length + 1 }));
    expect(await archiveJob(options)).toBe(false);
    expect(options.repository.failure).toHaveBeenCalledWith(options.job, 'MEDIA_SIZE_MISMATCH', expect.any(Date), false);
    expect(options.repository.complete).not.toHaveBeenCalled();
  });

  it('returns interrupted jobs to pending without consuming an attempt and logs only safe fields', async () => {
    const options = scenario();
    const controller = new AbortController();
    options.signal = controller.signal;
    let output = '';
    options.logger = pino(new Writable({ write(chunk: Buffer, _encoding, callback) { output += chunk.toString(); callback(); } }));
    options.files.download.mockImplementation(async () => { controller.abort(); throw new Error('https://api.telegram.org/file/botSECRET/private-file'); });
    expect(await archiveJob(options)).toBe(false);
    expect(options.repository.failure).toHaveBeenCalledWith(options.job, 'INTERRUPTED', expect.any(Date), true);
    expect(output).toContain('media_retry');
    for (const privateValue of ['SECRET', 'private-file', 'api.telegram.org', mediaConfig.s3.S3_SECRET_ACCESS_KEY]) expect(output).not.toContain(privateValue);
  });
});
