import { describe, expect, it } from 'vitest';
import { applicationErrorCode, databaseErrorCode } from '../../src/logger.js';

describe('sanitized diagnostics', () => {
  it('exposes only SQLSTATE and known operational codes', () => {
    expect(databaseErrorCode({ code: '08006', message: 'secret password' })).toBe('08006');
    expect(applicationErrorCode(new Error('MIGRATIONS_REQUIRED'))).toBe('MIGRATIONS_REQUIRED');
    expect(applicationErrorCode(new Error('COLLECTOR_ALREADY_RUNNING'))).toBe('COLLECTOR_ALREADY_RUNNING');
    expect(applicationErrorCode(new Error('private request URL'))).toBe('DATABASE_ERROR');
    expect(databaseErrorCode({ code: 'private request URL' })).toBe('DATABASE_ERROR');
  });
});
