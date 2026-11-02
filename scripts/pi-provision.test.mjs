import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Capture the real SSH commands and transferred archive without touching a Pi.
const sshStub = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.IMFRAME_TEST_LOG, JSON.stringify(args) + '\\n');
const command = args.at(-1);
if (command.includes('mktemp -d')) console.log('/tmp/imframe-setup.test123');
if (command.startsWith('tar -xf')) writeFileSync(process.env.IMFRAME_TEST_ARCHIVE, readFileSync(0));
if (command.startsWith('sudo bash')) process.exit(Number(process.env.IMFRAME_TEST_INSTALL_EXIT ?? 0));
`;

function provision(t, extra = [], installExit = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'imframe-provision-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ssh'), sshStub, { mode: 0o755 });
  const envFile = join(directory, 'frame connection.env');
  const credentials = 'IMMICH_URL=http://immich.example:2283\nIMMICH_API_KEY=test-only-key\n';
  writeFileSync(envFile, credentials, { mode: 0o600 });
  const log = join(directory, 'ssh.jsonl');
  const archive = join(directory, 'payload.tar');
  const result = spawnSync('bash', [resolve('deploy/pi/provision.sh'),
    '--host', 'frame.example', '--user', 'frame_user', '--env-file', envFile, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, IMFRAME_TEST_LOG: log,
      IMFRAME_TEST_ARCHIVE: archive, IMFRAME_TEST_INSTALL_EXIT: String(installExit) },
  });
  assert.ifError(result.error);
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const control = calls.flat().find(arg => arg.startsWith('ControlPath='));
  if (control) assert.equal(existsSync(dirname(control.slice('ControlPath='.length))), false, 'local credentials and SSH socket must be cleaned up');
  assert.doesNotMatch(JSON.stringify(calls) + result.stdout + result.stderr, /test-only-key/, 'credentials must not appear in command arguments or output');
  return { result, calls, archive, credentials };
}

test('remote setup transfers only deployment files and the private env file', t => {
  const { result, calls, archive, credentials } = provision(t, ['--browser', 'hevc']);
  assert.equal(result.status, 0, result.stderr);
  const list = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  for (const path of list.stdout.trim().split('\n')) {
    assert.match(path, /^\.\/(?:$|compose\.ghcr\.yaml$|connection\.env$|deploy\/(?:$|pi\/(?:$|[a-z.-]+\.(?:sh|service|timer|py|json)$)))/);
  }
  assert.equal(spawnSync('tar', ['-xOf', archive, './connection.env'], { encoding: 'utf8' }).stdout, credentials);
  assert.ok(calls.some(args => args.at(-1).includes("--browser 'hevc'")));
  assert.ok(calls.some(args => args.at(-1) === "rm -rf -- '/tmp/imframe-setup.test123'"));
  assert.ok(!calls.some(args => args.at(-1).includes('shutdown')));
});

test('failed installation cleans up credentials and does not reboot', t => {
  const { result, calls } = provision(t, ['--reboot'], 42);
  assert.equal(result.status, 42);
  assert.ok(calls.some(args => args.at(-1) === "rm -rf -- '/tmp/imframe-setup.test123'"));
  assert.ok(!calls.some(args => args.at(-1).includes('shutdown')));
});

test('explicit replacement and reboot remove transferred credentials before shutdown', t => {
  const { result, calls } = provision(t, ['--replace-config', '--reboot', '--browser', 'keep']);
  assert.equal(result.status, 0, result.stderr);
  const commands = calls.map(args => args.at(-1));
  assert.ok(commands.some(command => command.includes('--replace-config')));
  const cleanup = commands.indexOf("rm -rf -- '/tmp/imframe-setup.test123'");
  const reboot = commands.indexOf('sudo shutdown -r +1');
  assert.ok(cleanup >= 0 && reboot > cleanup);
});

test('invalid SSH targets and options fail before any connection', t => {
  for (const extra of [['--host', 'frame;touch /tmp/unwanted'], ['--user', 'root'], ['--port', '70000'], ['--browser', 'unknown']]) {
    const { result, calls } = provision(t, extra);
    assert.notEqual(result.status, 0);
    assert.deepEqual(calls, []);
  }
});
