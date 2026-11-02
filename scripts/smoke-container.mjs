import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2] ?? 'imframe:check';
const platform = process.argv[3];
const name = `imframe-smoke-${randomUUID()}`;
const volume = `${name}-settings`;
const hubName = `${name}-hub`;
const hubVolume = `${name}-hub-settings`;
const network = `${name}-network`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let base;
async function ready(container = name) {
  // Docker may assign a new ephemeral host port when the container restarts.
  const port = docker('port', container, '3000/tcp').match(/^127\.0\.0\.1:(\d+)$/)?.[1];
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
  docker('network', 'create', network);
  docker('run', '--detach', '--name', name, '--network', network, ...(platform ? ['--platform', platform] : []), '--publish', '127.0.0.1::3000', '--mount', `type=volume,source=${volume},target=/data`, image);
  const settings = await ready();
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(`${base}/frame`)).status, 200);
  assert.equal((await fetch(`${base}/hub-icon.png`)).headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}/manifest.webmanifest`)).headers.get('content-type'), 'application/manifest+json');
  const identity = (await (await fetch(`${base}/api/satellite`)).json()).id;
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
  assert.equal((await (await fetch(`${base}/api/satellite`)).json()).id, identity);
  const health = JSON.parse(docker('image', 'inspect', '--format', '{{json .Config.Healthcheck.Test}}', image));
  assert.equal(health[0], 'CMD-SHELL');
  docker('exec', name, 'sh', '-c', health[1]);
  assert.equal(docker('exec', name, 'node', '-e', 'process.stdout.write(String(Boolean(process.env.IMMICH_API_KEY)))'), 'false', 'The image must not contain a configured Immich key.');
  docker('run', '--detach', '--name', hubName, '--network', network, ...(platform ? ['--platform', platform] : []), '--env', 'IMFRAME_MODE=hub', '--publish', '127.0.0.1::3000', '--mount', `type=volume,source=${hubVolume},target=/data`, image);
  assert.equal((await ready(hubName)).mode, 'hub');
  assert.equal((await (await fetch(`${base}/api/app`)).json()).mode, 'hub');
  const added = await fetch(`${base}/api/hub/satellites`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: `${name}:3000` }) });
  assert.equal(added.status, 201, await added.clone().text());
  assert.equal((await added.json()).snapshot.name, 'Container smoke test');
  const changed = await fetch(`${base}/api/hub/satellites/${identity}/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photoSeconds: 15 }) });
  assert.equal(changed.status, 200); assert.equal((await changed.json()).pendingSettings, null);
  docker('restart', hubName); await ready(hubName);
  const fleet = await (await fetch(`${base}/api/hub`)).json();
  assert.equal(fleet.satellites.length, 1); assert.equal(fleet.satellites[0].snapshot.settings.photoSeconds, 15);
  docker('exec', hubName, 'sh', '-c', health[1]);
  console.log(`${image}${platform ? ` (${platform})` : ''}: satellite and Hub start, connect, save remote settings, preserve identity and membership after restart, serve icons, and pass health checks.`);
} finally {
  try { docker('rm', '--force', '--volumes', hubName); } catch { /* May not have started. */ }
  try { docker('rm', '--force', '--volumes', name); } catch { /* May not have started. */ }
  try { docker('volume', 'rm', hubVolume); } catch { /* May not have been created. */ }
  try { docker('volume', 'rm', volume); } catch { /* May not have been created. */ }
  try { docker('network', 'rm', network); } catch { /* May not have been created. */ }
}
