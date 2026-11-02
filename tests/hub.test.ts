import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { defaults } from '../shared/model.js';
import { SatelliteRuntime } from '../server/satellite.js';
import { Hub, createHubApp, satelliteAddress } from '../server/hub.js';
import { SettingsStore } from '../server/settings.js';
import { ImmichClient } from '../server/immich.js';
import { createApp } from '../server/app.js';
import { newId } from '../shared/id.js';

const snapshot = { asset: null, phase: 'photo', paused: false, position: 0, duration: 12,
  viewport: { width: 1920, height: 1080 }, fit: 'contain', videoSource: 'original', foregroundTransform: 'none', foregroundOrigin: '50% 50%' };
const report = (sessionId: string, kiosk = false) => ({ sessionId, kiosk, playback: snapshot });
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server) { server.closeAllConnections(); server.close(); await once(server, 'close'); }

test('LAN UUID generation does not require secure-context randomUUID', () => {
  assert.match(newId(), /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
  assert.notEqual(newId(), newId());
});

test('satellite identity and management survive restarts without storing API credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'imframe-satellite-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = new SatelliteRuntime(dir, '0.2.0'); await runtime.load();
  const hubId = randomUUID(); await runtime.manage({ hubId });
  const restarted = new SatelliteRuntime(dir, '0.2.0'); await restarted.load();
  assert.equal(runtime.info(defaults).id, restarted.info(defaults).id);
  assert.equal(restarted.info(defaults).update.managedBy, hubId);
  assert.equal(restarted.info(defaults).version, '0.2.0');
  assert.equal(restarted.info(defaults).playerOnline, false);
});

test('a kiosk owns playback reports; secondary browser previews cannot steal commands', async () => {
  const runtime = new SatelliteRuntime();
  const normal = randomUUID(); const kiosk = randomUUID();
  assert.equal(runtime.report(report(normal)).accepted, true);
  assert.equal(runtime.report(report(kiosk, true)).accepted, true);
  assert.equal(runtime.report(report(normal)).accepted, false);
  assert.equal(runtime.report(report(randomUUID(), true)).accepted, false);
  const id = randomUUID();
  const pending = runtime.command({ id, action: 'pause' });
  assert.equal(runtime.report(report(normal)).commands.length, 0);
  assert.equal(runtime.report(report(kiosk, true)).commands[0]!.id, id);
  runtime.acknowledge(id, { sessionId: normal });
  assert.equal(runtime.report(report(kiosk, true)).commands.length, 1);
  runtime.acknowledge(id, { sessionId: kiosk });
  assert.deepEqual(await pending, { acknowledged: true, id });
});

test('commands are idempotent, expire with an honest error, and never queue while offline', async () => {
  const runtime = new SatelliteRuntime(undefined, 'test', 25);
  assert.throws(() => runtime.command({ id: randomUUID(), action: 'next' }), /offline/);
  const session = randomUUID(); runtime.report(report(session));
  const id = randomUUID();
  const first = runtime.command({ id, action: 'next' });
  assert.equal(first, runtime.command({ id, action: 'next' }));
  assert.throws(() => runtime.command({ id, action: 'previous' }), /already been used/);
  runtime.acknowledge(id, { sessionId: session });
  await first;
  assert.deepEqual(await runtime.command({ id, action: 'next' }), { acknowledged: true, id });
  assert.equal(runtime.report(report(session)).commands.length, 0);
  await assert.rejects(runtime.command({ id: randomUUID(), action: 'next' }), /did not acknowledge/);
  assert.equal(runtime.report(report(session)).commands.length, 0);
});

test('previews are requested on demand and only accepted from the active player', () => {
  const runtime = new SatelliteRuntime();
  const session = randomUUID();
  assert.equal(runtime.report(report(session)).previewRequested, false);
  assert.equal(runtime.getPreview(), null);
  assert.equal(runtime.report(report(session)).previewRequested, true);
  runtime.setPreview(randomUUID(), Buffer.from('unrelated'));
  assert.equal(runtime.getPreview(), null);
  runtime.setPreview(session, Buffer.from('preview'));
  assert.equal(runtime.getPreview()!.bytes.toString(), 'preview');
  assert.ok(runtime.getPreview()!.capturedAt > 0);
  runtime.report(report(randomUUID(), true));
  assert.equal(runtime.getPreview(), null, 'a new kiosk cannot inherit another player’s old preview');
});

test('Hub discovery validates addresses and rejects credentials, redirects, and old frames', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'imframe-hub-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const input of ['file:///etc/passwd', 'http://user:pass@frame/', 'http://frame/path', 'http://frame/?key=x', 'http://frame/#key']) assert.throws(() => satelliteAddress(input));
  assert.equal(satelliteAddress('frame.local'), 'http://frame.local:3000');
  assert.equal(satelliteAddress('https://frame.local'), 'https://frame.local');
  assert.equal(satelliteAddress('[::1]:3000'), 'http://[::1]:3000');
  const hub = new Hub(dir, (async (_url, init) => { assert.equal(init!.redirect, 'error'); return Response.json({}); }) as typeof fetch);
  await assert.rejects(hub.discover('frame.local'), /supports Hub/);
});

test('Hub reads the remote name, patches all settings, persists membership and forwards media ranges', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'imframe-fleet-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = new SettingsStore(join(dir, 'satellite')); await settings.save({ ...defaults, name: 'Kitchen' });
  const satellite = new SatelliteRuntime(join(dir, 'satellite'), '0.2.0'); await satellite.load();
  const immich = new ImmichClient('https://immich.invalid', 'fixture-secret', (async (_url, init) => {
    if ((init!.headers as Record<string, string>).Range) return new Response('2345', { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 2-5/10' } });
    return Response.json([]);
  }) as typeof fetch);
  const server = createApp({ immich, settings, satellite }); const address = await listen(server); t.after(() => close(server));
  const hub = new Hub(join(dir, 'hub')); await hub.load();
  const added = await hub.add(address);
  assert.equal(added.snapshot.name, 'Kitchen');
  assert.equal(satellite.info(settings.get()).update.managedBy, hub.state().id);
  await assert.rejects(hub.add(address), /already been added/);
  await Promise.all([hub.settings(added.id, { photoSeconds: 20, showDate: true }), hub.settings(added.id, { showLocation: true })]);
  assert.equal(settings.get().photoSeconds, 20); assert.equal(settings.get().showDate, true); assert.equal(settings.get().showLocation, true);
  await settings.save({ name: 'Remote rename' }, true);
  assert.equal((await hub.refresh(added.id)).snapshot.name, 'Remote rename');
  await assert.rejects(hub.settings(added.id, { photoSeconds: 0 }), /photoSeconds/);
  const restarted = new Hub(join(dir, 'hub')); await restarted.load(); assert.equal(restarted.state().satellites.length, 1);
  const hubServer = createHubApp(hub); const base = await listen(hubServer); t.after(() => close(hubServer));
  const range = await fetch(`${base}/api/hub/satellites/${added.id}/media/${randomUUID()}/video`, { headers: { Range: 'bytes=2-5' } });
  assert.equal(range.status, 206); assert.equal(range.headers.get('Content-Range'), 'bytes 2-5/10'); assert.equal(await range.text(), '2345');
  const state = JSON.stringify(await (await fetch(`${base}/api/hub`)).json());
  assert.equal(state.includes('fixture-secret'), false);
  await hub.remove(added.id); assert.equal(hub.state().satellites.length, 0); assert.equal(satellite.info(settings.get()).update.managedBy, null);
});

test('offline settings persist in Hub and reconcile without overwriting unrelated direct changes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'imframe-offline-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let connected = true;
  let current = structuredClone(defaults);
  const id = randomUUID();
  const fetcher = (async (url, init) => {
    if (!connected) throw new Error('offline');
    if (String(url).endsWith('/settings')) { current = { ...current, ...JSON.parse(init!.body as string) }; return Response.json(current); }
    if (String(url).endsWith('/management')) return Response.json({ managedBy: null });
    return Response.json({ id, apiVersion: 1, name: current.name, settings: current, version: '0.2.0', update: { managedBy: null }, playerOnline: false, playback: null });
  }) as typeof fetch;
  const hub = new Hub(dir, fetcher); await hub.load(); await hub.add('frame.local');
  connected = false;
  const saved = await hub.settings(id, { photoSeconds: 21 }); assert.equal(saved.pendingSettings?.photoSeconds, 21);
  const restarted = new Hub(dir, fetcher); await restarted.load(); assert.equal(restarted.state().satellites[0]!.pendingSettings?.photoSeconds, 21);
  current.name = 'Changed directly'; connected = true;
  await restarted.refreshAll();
  assert.equal(current.name, 'Changed directly'); assert.equal(current.photoSeconds, 21);
  assert.equal(restarted.state().satellites[0]!.pendingSettings, null);
});

test('software update requests require the host agent and survive a satellite restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'imframe-update-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = new SatelliteRuntime(dir); await runtime.load();
  await assert.rejects(runtime.requestUpdate(), /Pi updater/);
  await runtime.agent({}); const state = await runtime.requestUpdate();
  const id = state.requested!.id;
  assert.equal((await runtime.requestUpdate()).requested!.id, id);
  await runtime.agent({ id, state: 'running' });
  assert.equal((await runtime.requestUpdate()).requested!.id, id);
  const restarted = new SatelliteRuntime(dir); await restarted.load();
  assert.equal(restarted.info(defaults).update.requested!.id, id);
  await restarted.agent({ id, state: 'succeeded' });
  assert.notEqual((await restarted.requestUpdate()).requested!.id, id);
});
