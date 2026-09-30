import { z } from 'zod';

export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const s3Schema = z.object({
  S3_ENDPOINT: z.url().refine(value => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  }).transform(value => new URL(value).origin),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1)
});
const integer = (fallback: number, max: number) => z.coerce.number().int().min(1).max(max).default(fallback);
const tuningSchema = z.object({
  MEDIA_CONCURRENCY: integer(2, 4),
  MEDIA_MAX_ATTEMPTS: integer(5, 20),
  MEDIA_JOB_TIMEOUT_SECONDS: integer(180, 1800),
  MEDIA_MAX_FILE_BYTES: integer(TELEGRAM_DOWNLOAD_LIMIT, TELEGRAM_DOWNLOAD_LIMIT)
});

export type S3Config = z.infer<typeof s3Schema>;
export type EnabledMediaConfig = z.infer<typeof tuningSchema> & { enabled: true; s3: S3Config };
export type MediaConfig = { enabled: false } | EnabledMediaConfig;

function parse<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`Invalid media environment: ${[...new Set(result.error.issues.map(issue => issue.path.join('.')))].join(', ')}`);
  return result.data;
}

export function readS3Config(env: NodeJS.ProcessEnv = process.env): S3Config { return parse(s3Schema, env); }
export function readMediaConfig(env: NodeJS.ProcessEnv = process.env): MediaConfig {
  const flag = env.MEDIA_ARCHIVE_ENABLED ?? 'false';
  if (flag === 'false') return { enabled: false };
  if (flag !== 'true') throw new Error('Invalid media environment: MEDIA_ARCHIVE_ENABLED');
  return { enabled: true, s3: readS3Config(env), ...parse(tuningSchema, env) };
}
