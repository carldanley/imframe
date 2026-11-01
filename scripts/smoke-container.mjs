import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2] ?? 'imframe:check';
const platform = process.argv[3];
const name = `imframe-smoke-${randomUUID()}`;
const volume = `${name}-settings`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let base;
async function ready() {
  // Docker may assign a new ephemeral host port when the container restarts.
  const port = docker('port', name, '3000/tcp').match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  assert.ok(port, 'Smoke test must bind only to localhost.');
  base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${base}/api/settings`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response.json();
    } catch { /* The container may still be starting. */ }
    await delay(250);
  }
  throw new Error('Container did not become ready.');
}

try {
  docker('run', '--detach', '--name', name, ...(platform ? ['--platform', platform] : []), '--publish', '127.0.0.1::3000', '--mount', `type=volume,source=${volume},target=/data`, image);
  const settings = await ready();
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(`${base}/frame`)).status, 200);
  assert.equal(docker('exec', name, 'id', '-u'), '1000', 'The app must run as the unprivileged node user.');
  const saved = await fetch(`${base}/api/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...settings, name: 'Container smoke test', photoSeconds: 9 }),
  });
  assert.equal(saved.status, 200, 'The settings volume must be writable.');
  docker('restart', name);
  const restored = await ready();
  assert.equal(restored.name, 'Container smoke test');
  assert.equal(restored.photoSeconds, 9);
  const health = JSON.parse(docker('image', 'inspect', '--format', '{{json .Config.Healthcheck.Test}}', image));
  assert.equal(health[0], 'CMD-SHELL');
  docker('exec', name, 'sh', '-c', health[1]);
  assert.equal(docker('exec', name, 'node', '-e', 'process.stdout.write(String(Boolean(process.env.IMMICH_API_KEY)))'), 'false', 'The image must not contain a configured Immich key.');
  console.log(`${image}${platform ? ` (${platform})` : ''}: starts, serves the app, runs as UID 1000, passes its health check, and retains settings after restart.`);
} finally {
  try { docker('rm', '--force', '--volumes', name); } catch { /* May not have started. */ }
  try { docker('volume', 'rm', volume); } catch { /* May not have been created. */ }
}
