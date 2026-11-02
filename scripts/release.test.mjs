import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { releaseMetadata } from './release.mjs';

function release(version = '1.2.3', overrides = {}) {
  return releaseMetadata({ version, lockVersion: version, lockPackageVersion: version,
    ref: `refs/tags/v${version}`, tags: [], ...overrides });
}

test('stable releases expose exact, minor, major, and latest tags', () => {
  assert.deepEqual(release(), { version: '1.2.3', release: true, minor: '1.2', major: '1',
    publish_latest: true, publish_minor: true, publish_major: true });
  assert.equal(release('0.1.0').publish_major, false);
});

test('prereleases and untagged builds never move release channels', () => {
  for (const result of [release('1.3.0-rc.1'), release('1.2.3', { ref: 'refs/heads/main' }), release('1.2.3', { ref: 'refs/pull/1/merge' })]) {
    assert.equal(result.publish_latest, false);
    assert.equal(result.publish_minor, false);
    assert.equal(result.publish_major, false);
  }
  assert.equal(release('1.2.3', { ref: 'refs/heads/main' }).release, false);
  assert.equal(release('1.3.0-rc.1').release, true);
});

test('backports can advance their own series without rolling newer channels backward', () => {
  const tags = ['v1.2.2', 'v1.3.0', 'v2.0.0'];
  const backport = release('1.2.3', { tags });
  assert.equal(backport.publish_minor, true);
  assert.equal(backport.publish_major, false);
  assert.equal(backport.publish_latest, false);
  assert.equal(release('1.3.1', { tags }).publish_major, true);
  assert.equal(release('1.2.1', { tags }).publish_minor, false);
});

test('channel ordering is numeric and ignores prereleases and unrelated tags', () => {
  const result = release('1.10.0', { tags: ['v1.9.9', 'v2.0.0-rc.1', 'backup', 'v01.11.0', 'v1.10.0'] });
  assert.equal(result.publish_latest, true);
  assert.equal(result.publish_major, true);
  assert.equal(release('1.9.10', { tags: ['v1.9.9'] }).publish_minor, true);
});

test('mismatched Git tags or lockfile versions stop publication', () => {
  for (const overrides of [{ ref: 'refs/tags/v1.2.4' }, { ref: 'refs/tags/1.2.3' }, { lockVersion: '1.2.2' }, { lockPackageVersion: '1.2.2' }]) {
    assert.throws(() => release('1.2.3', overrides), /must be|versions differ/);
  }
});

test('rejects malformed versions and unsupported Docker tag characters', () => {
  for (const version of ['v1.2.3', '01.2.3', '1.02.3', '1.2.03', '1.2', '1.2.3-', '1.2.3-rc..1', '1.2.3-rc.01', '1.2.3+build.1', '1.2.3\n', '1.2.3\nlatest', `1.2.3-${'x'.repeat(128)}`]) {
    assert.throws(() => release(version), /SemVer/);
  }
  assert.equal(release('1.2.3-rc.0').release, true);
  assert.equal(release('1.2.3-0a').release, true);
});

test('CLI writes the GitHub outputs consumed by the container workflow', t => {
  const directory = mkdtempSync(join(tmpdir(), 'imframe-release-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ version: '0.1.0', packages: { '': { version: '0.1.0' } } }));
  const output = join(directory, 'outputs');
  const result = spawnSync(process.execPath, [resolve('scripts/release.mjs')], {
    cwd: directory, encoding: 'utf8',
    env: { ...process.env, GIT_DIR: execFileSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim(), GITHUB_REF: 'refs/tags/v0.1.0', GITHUB_OUTPUT: output },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(output, 'utf8'), /^version=0\.1\.0\nrelease=true\n/m);
  assert.match(readFileSync(output, 'utf8'), /^publish_major=false$/m);
});
