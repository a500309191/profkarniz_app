import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

// Never print merged config: production .env may contain secrets. Override the
// two secret fields with dummy values and inspect only networking properties.
const env = { ...process.env, POSTGRES_PASSWORD: 'compose-validation-only',
  TELEGRAM_BOT_TOKEN: '123:COMPOSE_VALIDATION_ONLY', HTTP_PORT: '3300', HOST_POSTGRES_PORT: '55433' };
function config(files) {
  return JSON.parse(execFileSync('docker', ['compose', ...files.flatMap(file => ['-f', file]),
    'config', '--format', 'json'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

try {
  const base = config(['docker-compose.yml']);
  const host = config(['docker-compose.yml', 'docker-compose.host-network.yml']);
  const app = host.services.application;
  assert.equal(base.services.postgres.ports, undefined);
  assert.equal(base.services.application.ports[0].host_ip, '127.0.0.1');
  assert.equal(app.network_mode, 'host');
  assert.equal(app.networks, undefined);
  assert.equal(app.ports?.length ?? 0, 0);
  assert.equal(app.environment.HTTP_HOST, '127.0.0.1');
  assert.equal(app.environment.HTTP_PORT, '3300');
  assert.equal(app.environment.PGHOST, '127.0.0.1');
  assert.equal(app.environment.PGPORT, '55433');
  assert.equal(host.services.postgres.ports.length, 1);
  assert.equal(host.services.postgres.ports[0].host_ip, '127.0.0.1');
  assert.equal(host.services.postgres.ports[0].published, '55433');
  assert.equal(host.services.postgres.ports[0].target, 5432);
  assert.equal(host.services.migrate.environment.PGHOST, 'postgres');
  assert.equal(host.services.migrate.network_mode, undefined);
  assert.equal(host.volumes.postgres_data.name, base.volumes.postgres_data.name);
  assert.equal(app.read_only, true);
  assert.ok(app.healthcheck.test.at(-1).includes('process.env.HTTP_PORT'));
  process.stdout.write('Compose networking checks passed (default bridge and opt-in Linux host mode).\n');
} catch {
  process.stderr.write('Compose networking checks failed; check Docker Compose version and the override.\n');
  process.exitCode = 1;
}
