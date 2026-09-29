import { describe, expect, it } from 'vitest';
import { readConfig, readDatabaseConfig } from '../../src/config.js';

describe('configuration', () => {
  it('requires credentials instead of inventing defaults', () => {
    expect(() => readConfig({})).toThrow('TELEGRAM_BOT_TOKEN');
    expect(() => readDatabaseConfig({})).toThrow('POSTGRES_PASSWORD');
  });
  it('does not include invalid secret values in validation errors', () => {
    try { readConfig({ TELEGRAM_BOT_TOKEN: 'sensitive-value', POSTGRES_PASSWORD: 'private-password' }); }
    catch (error) {
      expect(String(error)).toContain('TELEGRAM_BOT_TOKEN');
      expect(String(error)).not.toContain('sensitive-value');
      expect(String(error)).not.toContain('private-password');
    }
  });
  it('allows migrations without a Telegram token', () => {
    expect(readDatabaseConfig({ POSTGRES_PASSWORD: 'test-only' }).PGHOST).toBe('127.0.0.1');
  });
});
