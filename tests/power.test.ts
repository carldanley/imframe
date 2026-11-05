import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { powerState } from '../shared/power.js';
import { defaults } from '../shared/model.js';
import { SatelliteRuntime } from '../server/satellite.js';
import { SettingsStore } from '../server/settings.js';
import { ImmichClient } from '../server/immich.js';
import { createApp } from '../server/app.js';

const night = { ...defaults, sleepEnabled: true, sleepStart: '22:00', sleepEnd: '07:30' };
const zone = 'America/New_York';
const host = { sleeping: true, timeZone: zone, error: null, kioskRunning: false };
const album = '11111111-1111-4111-8111-111111111111';
const asset = '22222222-2222-4222-8222-222222222222';

test('sleep stops at the wake boundary, with exactly two minutes of preloading', () => {
  for (const [time, phase] of [['21:59:59', 'awake'], ['22:00:00', 'sleeping'], ['00:00:00', 'sleeping'],
    ['07:27:59', 'sleeping'], ['07:28:00', 'warming'], ['07:29:59', 'warming'], ['07:30:00', 'awake']]) {
    assert.equal(powerState(night, zone, Date.parse(`2026-11-05T${time}-05:00`)).phase, phase, time);
  }
  assert.equal(powerState({ ...night, sleepEnabled: false }, zone, Date.parse('2026-11-05T01:00-05:00')).phase, 'awake');
  const daytime = { ...night, sleepStart: '09:00', sleepEnd: '17:00' };
  assert.equal(powerState(daytime, zone, Date.parse('2026-11-05T16:58-05:00')).phase, 'warming');
  assert.equal(powerState(daytime, zone, Date.parse('2026-11-05T23:00-05:00')).phase, 'awake');
});

test('preloading follows real elapsed time across skipped and repeated DST hours', () => {
  const skipped = { ...night, sleepEnd: '02:30' };
  assert.equal(powerState(skipped, zone, Date.parse('2026-03-08T06:57:59Z')).phase, 'sleeping');
  assert.equal(powerState(skipped, zone, Date.parse('2026-03-08T06:58:00Z')).phase, 'warming');
  assert.equal(powerState(skipped, zone, Date.parse('2026-03-08T07:00:00Z')).phase, 'awake');
  const repeated = { ...night, sleepEnd: '02:00' };
  assert.equal(powerState(repeated, zone, Date.parse('2026-11-01T05:59:00Z')).phase, 'sleeping');
  assert.equal(powerState(repeated, zone, Date.parse('2026-11-01T06:58:00Z')).phase, 'warming');
  assert.equal(powerState(repeated, zone, Date.parse('2026-11-01T07:00:00Z')).phase, 'awake');
  // A one-minute awake window still gets a warmup rather than being skipped.
  assert.equal(powerState({ ...night, sleepStart: '07:31' }, zone, Date.parse('2026-11-05T07:29:30-05:00')).phase, 'warming');
});

test('the Pi time zone survives container restarts without claiming a live host connection', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-05T12:28:00Z'));
  const dir = await mkdtemp(join(tmpdir(), 'imframe-zone-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const before = new SatelliteRuntime(dir); await before.load(); await before.displayAgent(host, night);
  const after = new SatelliteRuntime(dir); await after.load();
  assert.equal(after.power(night).phase, 'warming');
  assert.equal(after.info(night).display?.connected, false);
  assert.equal(before.info(night).display?.kioskRunning, false);
});

test('sleep gates media and library reads, aborts in-flight work, and resumes during warmup', async t => {
  let now = Date.parse('2026-11-05T17:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const dir = await mkdtemp(join(tmpdir(), 'imframe-power-api-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = new SettingsStore(dir); await settings.load(); await settings.save({ ...night, albumIds: [album] });
  const satellite = new SatelliteRuntime(); await satellite.displayAgent(host, settings.get());
  let block = false;
  const calls: string[] = [];
  const aborted: string[] = [];
  const immich = new ImmichClient('http://immich.invalid', 'test-only', (async (url, init) => {
    const path = new URL(String(url)).pathname; calls.push(path);
    if (path.endsWith('/albums')) return Response.json([{ id: album, albumName: 'Test', assetCount: 1 }]);
    if (block && path.includes('/assets/')) return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        init!.signal!.addEventListener('abort', () => { aborted.push(path); controller.error(init!.signal!.reason); }, { once: true });
      },
    }));
    if (block) return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { aborted.push(path); reject(init!.signal!.reason); }, { once: true });
    });
    if (path.endsWith('/metadata')) return Response.json({ assets: { items: [], nextCursor: null } });
    return new Response('media');
  }) as typeof fetch);
  const server = createApp({ settings, satellite, immich }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); server.close(); await once(server, 'close'); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const mediaPath = `/api/media/${asset}/video`;
  assert.equal((await fetch(url + mediaPath)).status, 200);
  block = true;
  const video = fetch(url + mediaPath);
  const library = fetch(url + '/api/library');
  for (let i = 0; i < 100 && calls.length < 4; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls.length, 4);
  const reader = (await video).body!.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2, 3]));
  const interrupted = assert.rejects(reader.read());
  now = Date.parse('2026-11-06T03:00:00Z');
  assert.equal((await (await fetch(url + '/api/power')).json()).phase, 'sleeping');
  await Promise.all([interrupted, library]);
  assert.equal(aborted.length, 2, 'sleep must abort both a media transfer and album pagination');
  const before = calls.length;
  for (const path of [mediaPath, `/api/media/${asset}/photo`, `/api/media/${asset}/thumbnail`, '/api/library?refresh=1']) {
    assert.equal((await fetch(url + path)).status, 423);
  }
  assert.equal(calls.length, before, 'sleeping requests must never reach Immich');
  assert.equal((await fetch(url + '/api/settings')).status, 200);
  assert.equal((await fetch(url + '/api/albums')).status, 200, 'explicit settings access remains available');
  block = false; now = Date.parse('2026-11-06T12:28:00Z');
  assert.equal((await (await fetch(url + '/api/power')).json()).phase, 'warming');
  assert.equal((await fetch(url + mediaPath)).status, 200);
  assert.equal((await fetch(url + '/api/library')).status, 200);
  now = Date.parse('2026-11-06T12:30:00Z');
  assert.equal((await (await fetch(url + '/api/power')).json()).phase, 'awake');
});
