import { z } from 'zod';
import { readMediaConfig, type MediaConfig } from './media/config.js';

const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const databaseSchema = z.object({
  PGHOST: z.string().min(1).default('127.0.0.1'),
  PGPORT: integer(5432, 1, 65535),
  POSTGRES_USER: z.string().min(1).default('profkarniz'),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_DB: z.string().min(1).default('profkarniz')
});

const appSchema = databaseSchema.extend({
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/),
  HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  HTTP_PORT: integer(3000, 1, 65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TELEGRAM_POLL_TIMEOUT_SECONDS: integer(30, 1, 50),
  HEALTH_STALE_SECONDS: integer(120, 60, 3600),
  SHUTDOWN_TIMEOUT_SECONDS: integer(25, 5, 120)
});

export type DatabaseConfig = z.infer<typeof databaseSchema>;
export type Config = z.infer<typeof appSchema> & { media: MediaConfig };

export function readDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  return parseConfig(databaseSchema, env);
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return { ...parseConfig(appSchema, env), media: readMediaConfig(env) };
}

function parseConfig<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Zod issues can include input values; only expose variable names.
    const fields = [...new Set(result.error.issues.map(issue => issue.path.join('.')))];
    throw new Error(`Invalid environment variables: ${fields.join(', ')}`);
  }
  return result.data;
}
