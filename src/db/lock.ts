import type pg from 'pg';

// A dedicated session holds leadership throughout polling. Losing it is fatal:
// the old process must stop before a replacement acknowledges new updates.
export async function acquireCollectorLock(pool: pg.Pool, botId: string, onLost: () => void) {
  const client = await pool.connect();
  let releasing = false;
  const lost = () => { if (!releasing) onLost(); };
  client.on('error', lost);
  client.on('end', lost);
  try {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked', [botId]);
    if (!result.rows[0]?.locked) throw new Error('COLLECTOR_ALREADY_RUNNING');
  } catch (error) {
    releasing = true;
    client.release(true);
    throw error;
  }
  return {
    async assertHeld() { await client.query('SELECT 1'); },
    release() {
      releasing = true;
      // Closing the session releases its advisory lock even on network failures.
      client.release(true);
    }
  };
}
