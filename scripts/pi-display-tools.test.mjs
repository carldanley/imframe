import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'imframe-display-tools-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin'), target = join(directory, 'tools');
  mkdirSync(bin);
  // Keep the test independent of whether this machine has wlrctl installed.
  symlinkSync(process.execPath, join(bin, 'node'));
  for (const tool of ['bash', 'mktemp', 'rm', 'install', 'cp']) {
    const source = spawnSync('which', [tool], { encoding: 'utf8' });
    assert.equal(source.status, 0);
    symlinkSync(source.stdout.trim(), join(bin, tool));
  }
  writeFileSync(join(bin, 'apt-get'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
if(process.env.IMFRAME_TEST_DOWNLOAD_FAIL)process.exit(42);
writeFileSync('wlrctl_test.deb','fixture');
`, { mode: 0o755 });
  writeFileSync(join(bin, 'dpkg-deb'), `#!/usr/bin/env node
import { mkdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
const target=process.argv.at(-1);
mkdirSync(join(target,'usr/bin'),{recursive:true});
mkdirSync(join(target,'usr/share/doc/wlrctl'),{recursive:true});
writeFileSync(join(target,'usr/bin/wlrctl'),'#!/bin/sh\\nexit '+(process.env.IMFRAME_TEST_RUNTIME_FAIL?'1':'0')+'\\n',{mode:0o755});
writeFileSync(join(target,'usr/share/doc/wlrctl/copyright'),'fixture license');
`, { mode: 0o755 });
  const run = (extra = {}) => spawnSync('bash', [resolve('deploy/pi/install-display-tools.sh'), target], {
    encoding: 'utf8', env: { ...process.env, PATH: bin, ...extra },
  });
  return { bin, target, run };
}

test('display-tool upgrade keeps the executable and license and works without sudo', t => {
  const { target, run } = setup(t);
  const first = run(); assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(join(target, 'usr/bin/wlrctl')));
  assert.equal(readFileSync(join(target, 'usr/share/doc/wlrctl/copyright'), 'utf8'), 'fixture license');
  const again = run({ IMFRAME_TEST_DOWNLOAD_FAIL: '1' });
  assert.equal(again.status, 0, 'installed tools must not need a network request on each upgrade');
});

test('failed download or missing runtime libraries leave the tool directory untouched', t => {
  for (const extra of [{ IMFRAME_TEST_DOWNLOAD_FAIL: '1' }, { IMFRAME_TEST_RUNTIME_FAIL: '1' }]) {
    const { target, run } = setup(t);
    assert.notEqual(run(extra).status, 0);
    assert.equal(existsSync(target), false);
  }
});

test('an existing system wlrctl avoids downloading a private copy', t => {
  const { bin, target, run } = setup(t);
  writeFileSync(join(bin, 'wlrctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(run({ IMFRAME_TEST_DOWNLOAD_FAIL: '1' }).status, 0);
  assert.equal(existsSync(target), false);
});
