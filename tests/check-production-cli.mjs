import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

// Run the built runtime image itself: no source mounts, inherited credentials,
// external network, PostgreSQL or S3. An application config error is expected;
// shell errors, missing modules and a dependency on tsx must fail this smoke test.
const image = process.argv[2] ?? 'profkarniz-app:ci';
function run(command) {
  const name = `profkarniz-cli-smoke-${randomUUID()}`;
  try {
    const result = spawnSync('docker', ['run', '--rm', '--pull=never', '--name', name,
      '--network=none', '--read-only', '--tmpfs', '/tmp:size=16777216,mode=1777',
      '--env', 'NPM_CONFIG_CACHE=/tmp/npm', image, ...command],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'Runtime container was interrupted');
    return result;
  } finally {
    // Only this invocation's randomly named test container, including on timeout.
    spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore', timeout: 10_000 });
  }
}

const layout = run(['node', '--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  import { existsSync } from 'node:fs';
  import { createRequire } from 'node:module';
  assert.equal(existsSync('/app/dist/media/cli.js'), true, 'Compiled media CLI missing');
  assert.equal(existsSync('/app/src'), false, 'Runtime must not rely on TypeScript sources');
  assert.throws(() => createRequire('/app/package.json').resolve('tsx'), { code: 'MODULE_NOT_FOUND' });
  assert.notEqual(process.getuid(), 0, 'Runtime must remain unprivileged');
`]);
assert.equal(layout.status, 0, `Invalid production image layout:\n${layout.stdout}${layout.stderr}`);

for (const script of ['s3:check', 'media:backfill', 'media:retry-failed']) {
  // Test the public npm entrypoint used by deployment, not a direct node shortcut.
  const result = run(['npm', 'run', script]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1, `${script} must reach environment validation:\n${output}`);
  assert.doesNotMatch(output, /tsx:|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find module|Unknown command|Missing script/i);
  const records = result.stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.equal(records.length, 1, `${script} did not emit its structured config failure:\n${output}`);
  assert.equal(records[0].event, 'media_command_failed', `${script} did not reach the application CLI`);
  assert.equal(records[0].code, script === 's3:check' ? 'S3_NETWORK' : 'MEDIA_DATABASE');
  assert.equal(records[0].hint, 'Check required environment variables, migrations and service access');
  process.stdout.write(`${script}: production entrypoint reached environment validation without tsx.\n`);
}
process.stdout.write('Production CLI smoke tests passed (network disabled, no credentials).\n');
