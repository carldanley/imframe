import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Model Docker's external state so failure paths can be checked without replacing
// the real frame. Lock/timing utilities are stubbed for macOS portability.
const dockerStub = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.env.IMFRAME_TEST_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
function finish(output = '', code = 0) {
  writeFileSync(file, JSON.stringify(state));
  if (output) console.log(output);
  process.exit(code);
}
if (args[0] === 'compose') {
  const verb = args.find(arg => ['config', 'ps', 'pull', 'up'].includes(arg));
  if (verb === 'config') finish(args.includes('--images') ? 'test/imframe:latest' : '');
  if (verb === 'ps') finish(state.container);
  if (verb === 'pull') {
    state.pulls++;
    finish('', state.pullFails ? 1 : 0);
  }
  if (verb === 'up') {
    const rollback = process.env.IMFRAME_IMAGE === 'imframe:rollback';
    state.activations.push(rollback ? 'rollback' : 'current');
    const image = rollback ? state.rollbackImage : state.desiredImage;
    if (state.image !== image || !state.container) {
      state.image = image;
      state.container = 'container-' + state.activations.length;
    }
    finish('', !rollback && state.unhealthy ? 1 : 0);
  }
}
if (args[0] === 'inspect') finish(state.image);
if (args[0] === 'image' && args[1] === 'inspect') finish(state.desiredImage);
if (args[0] === 'image' && args[1] === 'tag') {
  state.rollbackImage = args[2];
  finish();
}
throw new Error('Unexpected Docker call: ' + args.join(' '));
`;

function update(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'imframe-update-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(join(directory, '.env'), 'IMFRAME_IMAGE=test/imframe:latest\n');
  const stateFile = join(directory, 'state.json');
  writeFileSync(stateFile, JSON.stringify({
    image: 'old-image', desiredImage: 'old-image', container: 'original-container',
    pulls: 0, activations: [], ...overrides,
  }));
  writeFileSync(join(bin, 'docker'), dockerStub, { mode: 0o755 });
  writeFileSync(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
  const result = spawnSync('bash', [resolve('deploy/pi/update.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`,
      IMFRAME_DIR: directory, IMFRAME_PROJECT: 'imframe', IMFRAME_USER: '',
      IMFRAME_TEST_STATE: stateFile,
    },
  });
  assert.ifError(result.error);
  return { result, state: JSON.parse(readFileSync(stateFile, 'utf8')) };
}

test('an unchanged published image leaves the running container intact', t => {
  const { result, state } = update(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.container, 'original-container');
  assert.equal(state.image, 'old-image');
  assert.match(result.stdout, /playback left running/);
});

test('a failed pull never replaces or stops the working container', t => {
  const { result, state } = update(t, { pullFails: true, desiredImage: 'new-image' });
  assert.notEqual(result.status, 0);
  assert.equal(state.pulls, 1);
  assert.equal(state.container, 'original-container');
  assert.equal(state.image, 'old-image');
  assert.deepEqual(state.activations, []);
});

test('a healthy update retains the previous image for rollback', t => {
  const { result, state } = update(t, { desiredImage: 'new-image' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.image, 'new-image');
  assert.equal(state.rollbackImage, 'old-image');
  assert.notEqual(state.container, 'original-container');
  assert.deepEqual(state.activations, ['current']);
});

test('an unhealthy update restores the previous image and reports the failed update', t => {
  const { result, state } = update(t, { desiredImage: 'new-image', unhealthy: true });
  assert.notEqual(result.status, 0);
  assert.equal(state.image, 'old-image');
  assert.deepEqual(state.activations, ['current', 'rollback']);
});

test('a first installation starts without requiring an existing container', t => {
  const { result, state } = update(t, { image: '', container: '', desiredImage: 'new-image' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.image, 'new-image');
  assert.deepEqual(state.activations, ['current']);
  assert.equal(state.rollbackImage, undefined);
});
