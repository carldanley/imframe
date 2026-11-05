import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { defaults, parseSettings, type FrameSettings } from '../shared/model.js';
import { SettingsStore } from '../server/settings.js';
import { SatelliteRuntime } from '../server/satellite.js';
import { createApp } from '../server/app.js';
import { ImmichClient } from '../server/immich.js';
import { Hub } from '../server/hub.js';

const report = { sleeping: true, timeZone: 'America/New_York', error: null };

test('existing frame settings default to an awake screen and sleep hours persist', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'imframe-sleep-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const legacy: Partial<FrameSettings> = { ...defaults, name: 'Kitchen' };
  delete legacy.sleepEnabled; delete legacy.sleepStart; delete legacy.sleepEnd;
  await writeFile(join(dir, 'settings.json'), JSON.stringify(legacy));
  const store = new SettingsStore(dir); await store.load();
  assert.equal(store.get().sleepEnabled, false);
  assert.equal(store.get().sleepStart, '22:00');
  await store.save({ sleepEnabled: true, sleepStart: '21:30', sleepEnd: '06:15' }, true);
  const restarted = new SettingsStore(dir); await restarted.load();
  assert.equal(restarted.get().sleepStart, '21:30');
  assert.equal(restarted.get().sleepEnd, '06:15');
  assert.equal(restarted.get().sleepEnabled, true);
  assert.equal(restarted.get().name, 'Kitchen');
});

test('sleep hours reject malformed times and equal active boundaries', () => {
  for (const value of ['24:00', '7:00', '12:60', '', null, 700]) {
    assert.throws(() => parseSettings({ ...defaults, sleepStart: value }), /valid sleep or wake time/);
  }
  assert.throws(() => parseSettings({ ...defaults, sleepEnabled: true, sleepEnd: defaults.sleepStart }), /different/);
  assert.throws(() => parseSettings({ ...defaults, sleepEnabled: 'yes' }), /sleepEnabled/);
  assert.equal(parseSettings({ ...defaults, sleepStart: '00:00' }).sleepStart, '00:00');
});

test('display state requires a recent host report and never survives as a false healthy state', async t => {
  const satellite = new SatelliteRuntime();
  assert.equal(satellite.info(defaults).display?.connected, false);
  assert.deepEqual(await satellite.displayAgent(report, defaults), { sleepEnabled: false, sleepStart: '22:00', sleepEnd: '07:00', power: { phase: 'awake', warmupSeconds: 120 } });
  assert.equal(satellite.info(defaults).display?.connected, true);
  assert.equal(satellite.info(defaults).display?.sleeping, true);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 46_000);
  assert.equal(satellite.info(defaults).display?.connected, false);
  assert.equal(new SatelliteRuntime().info(defaults).display?.connected, false);
  await assert.rejects(satellite.displayAgent({ ...report, sleeping: 'yes' }, defaults), /Invalid display report/);
  await assert.rejects(satellite.displayAgent({ ...report, timeZone: 'invalid/zone' }, defaults), /Invalid display time zone/);
});

test('Hub can save sleep hours and receive physical display state through the satellite API', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-05T05:00:00Z'));
  const dir = await mkdtemp(join(tmpdir(), 'imframe-sleep-api-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = new SettingsStore(join(dir, 'satellite')); await settings.load();
  const satellite = new SatelliteRuntime();
  const server = createApp({ settings, satellite, immich: new ImmichClient('http://immich.invalid', '') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); server.close(); await once(server, 'close'); });
  const address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const hub = new Hub(join(dir, 'hub')); await hub.load(); t.after(() => hub.close());
  const frame = await hub.add(address);
  await hub.settings(frame.id, { sleepEnabled: true, sleepStart: '23:15', sleepEnd: '08:30' });
  const response = await fetch(`${address}/api/display-agent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sleepEnabled: true, sleepStart: '23:15', sleepEnd: '08:30', power: { phase: 'sleeping', warmupSeconds: 120 } });
  assert.deepEqual((await hub.refresh(frame.id)).snapshot.display, { ...report, phase: 'sleeping', connected: true });
  await hub.settings(frame.id, { sleepEnabled: false });
  assert.equal(settings.get().sleepEnabled, false);
});
