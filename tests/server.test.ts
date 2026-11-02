import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { defaults, formatLocation, formatTakenDate, parseSettings } from '../shared/model.js';
import { ImmichClient } from '../server/immich.js';
import { SettingsStore } from '../server/settings.js';
import { createApp } from '../server/app.js';

const id = '11111111-1111-4111-8111-111111111111';
const albumId = '22222222-2222-4222-8222-222222222222';
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server) { server.closeAllConnections(); server.close(); await once(server, 'close'); }

test('cursor pagination loads every page, preserves v3 millisecond durations, and rejects repeated cursors', async () => {
  const bodies: Record<string, unknown>[] = [];
  let repeated = false;
  const client = new ImmichClient('https://immich.invalid', 'fixture-key', (async (_url, init) => {
    assert.equal((init!.headers as Record<string, string>)['x-api-key'], 'fixture-key');
    const body = JSON.parse(init!.body as string); bodies.push(body);
    const page = body.cursor ? 2 : 1;
    return Response.json({ assets: { items: [{ id: `${page}`, type: 'VIDEO', duration: 13500, originalFileName: 'clip.mov', fileCreatedAt: '', updatedAt: '', width: 3840, height: 2160 }], nextCursor: page === 1 || repeated ? 'page-two' : null, total: 1 } });
  }) as typeof fetch);
  const result = await client.albumMedia(albumId);
  assert.equal(result.media.length, 2);
  assert.equal(result.media[0]!.durationMs, 13500);
  assert.deepEqual(bodies[0]!.filter, { albumIds: { any: [albumId] }, trashedAt: { eq: null }, type: { in: ['IMAGE', 'VIDEO'] } });
  assert.equal(bodies[1]!.cursor, 'page-two');
  assert.equal(bodies[0]!.withExif, true);
  repeated = true;
  await assert.rejects(client.albumMedia(albumId), /repeated a pagination cursor/);
});

test('location labels use available Immich place names, omit duplicates, and stay absent without names', async () => {
  const places = [
    { city: ' Juneau ', state: 'Alaska', country: 'United States' },
    { city: 'Singapore', state: 'singapore', country: 'Singapore' },
    { city: null, state: 'Alaska', country: null },
    { city: 'Washington, D.C.', state: null, country: 'United States' },
    { city: null, state: null, country: 'Canada' },
    { city: ' ', state: null, country: null, latitude: 58.3, longitude: -134.4 },
    null,
  ];
  const client = new ImmichClient('https://immich.invalid', 'fixture-key', (async () => Response.json({
    assets: { items: places.map((exifInfo, i) => ({ id: String(i), type: 'IMAGE', exifInfo })), nextCursor: null },
  })) as typeof fetch);
  const result = await client.albumMedia(albumId);
  assert.deepEqual(result.media.map(media => media.location), [
    { city: 'Juneau', state: 'Alaska', country: 'United States' },
    { city: 'Singapore', state: null, country: null },
    { city: null, state: 'Alaska', country: null },
    { city: 'Washington, D.C.', state: null, country: 'United States' },
    { city: null, state: null, country: 'Canada' },
    null, null,
  ]);
  assert.equal(formatLocation(result.media[0]!.location), 'Juneau, Alaska, United States');
});

test('capture metadata preserves the local date independently of chronological ordering', async () => {
  const client = new ImmichClient('https://immich.invalid', 'fixture-key', (async () => Response.json({
    assets: { items: [
      { id, type: 'IMAGE', fileCreatedAt: '2026-01-03T07:30:00Z', localDateTime: '2026-01-02T23:30:00.000Z' },
      { id: 'other', type: 'VIDEO', fileCreatedAt: '2026-03-09T14:00:00Z' },
    ], nextCursor: null },
  })) as typeof fetch);
  const { media } = await client.albumMedia(albumId);
  assert.equal(media[0]!.takenAt, '2026-01-03T07:30:00Z');
  assert.equal(formatTakenDate(media[0]!.localDateTime), '01.02.26');
  assert.equal(media[1]!.localDateTime, null);
  assert.equal(formatTakenDate(media[1]!.takenAt), '03.09.26');
});

test('existing settings gain overlay defaults without losing albums; overlay preferences persist and validate', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'imframe-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { showLocation, locationCorner, showDate, dateCorner, progressStyle, progressPosition, progressCorner, ...legacy } = { ...defaults, albumIds: [albumId], name: 'Kitchen' };
  await writeFile(join(dir, 'settings.json'), JSON.stringify(legacy));
  const store = new SettingsStore(dir); await store.load();
  assert.equal(store.get().showLocation, false);
  assert.equal(store.get().locationCorner, 'bottom-left');
  assert.equal(store.get().showDate, false);
  assert.equal(store.get().dateCorner, 'top-left');
  assert.equal(store.get().progressStyle, 'off');
  assert.equal(store.get().progressPosition, 'bottom');
  assert.equal(store.get().progressCorner, 'bottom-right');
  assert.deepEqual(store.get().albumIds, [albumId]);
  await store.save({ ...store.get(), showLocation: true, locationCorner: 'top-right', showDate: true, dateCorner: 'bottom-left', progressStyle: 'ring', progressPosition: 'right', progressCorner: 'top-left' });
  const restarted = new SettingsStore(dir); await restarted.load();
  assert.equal(restarted.get().showLocation, true);
  assert.equal(restarted.get().locationCorner, 'top-right');
  assert.equal(restarted.get().showDate, true);
  assert.equal(restarted.get().dateCorner, 'bottom-left');
  assert.equal(restarted.get().progressStyle, 'ring');
  assert.equal(restarted.get().progressPosition, 'right');
  assert.equal(restarted.get().progressCorner, 'top-left');
  assert.equal(restarted.get().name, 'Kitchen');
  assert.throws(() => parseSettings({ ...defaults, locationCorner: 'center' }), /locationCorner/);
  assert.throws(() => parseSettings({ ...defaults, showLocation: 'yes' }), /showLocation/);
  assert.throws(() => parseSettings({ ...defaults, showDate: 'yes' }), /showDate/);
  assert.throws(() => parseSettings({ ...defaults, dateCorner: 'center' }), /dateCorner/);
  assert.throws(() => parseSettings({ ...defaults, progressStyle: 'spinner' }), /progressStyle/);
  assert.throws(() => parseSettings({ ...defaults, progressPosition: 'center' }), /progressPosition/);
  assert.throws(() => parseSettings({ ...defaults, progressCorner: 'right' }), /progressCorner/);
});

test('preload preferences default for existing frames and persist within supported limits', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'imframe-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { preloadCount, preloadMegabytes, ...legacy } = defaults;
  await writeFile(join(dir, 'settings.json'), JSON.stringify(legacy));
  const store = new SettingsStore(dir); await store.load();
  assert.equal(store.get().preloadCount, 3);
  assert.equal(store.get().preloadMegabytes, 512);
  await store.save({ ...store.get(), preloadCount: 5, preloadMegabytes: 1024 });
  const restarted = new SettingsStore(dir); await restarted.load();
  assert.equal(restarted.get().preloadCount, 5);
  assert.equal(restarted.get().preloadMegabytes, 1024);
  for (const value of [0, 6, 1.5]) assert.throws(() => parseSettings({ ...defaults, preloadCount: value }), /preloadCount/);
  for (const value of [0, 513, 2048]) assert.throws(() => parseSettings({ ...defaults, preloadMegabytes: value }), /preloadMegabytes/);
});

test('legacy circular countdowns move to corners while bar edge preferences stay intact', () => {
  const { progressCorner, ...legacy } = defaults;
  for (const [edge, corner] of Object.entries({ top: 'top-right', bottom: 'bottom-right', left: 'bottom-left', right: 'bottom-right' })) {
    const ring = parseSettings({ ...legacy, progressStyle: 'ring', progressPosition: edge });
    assert.equal(ring.progressCorner, corner);
    assert.equal(ring.progressPosition, edge);
    const bar = parseSettings({ ...legacy, progressStyle: 'bar', progressPosition: edge });
    assert.equal(bar.progressPosition, edge);
    assert.equal(bar.progressCorner, 'bottom-right');
  }
});

test('full-size images never silently fall back to previews, and redirects cannot leak the API key', async () => {
  let target = `/api/assets/${id}/thumbnail?size=preview`;
  let calls = 0;
  const client = new ImmichClient('https://immich.invalid', 'fixture-key', (async () => {
    calls++; return new Response(null, { status: 302, headers: { Location: target } });
  }) as typeof fetch);
  await assert.rejects(client.media(id, 'photo', undefined, new AbortController().signal), /Full-size photo unavailable/);
  assert.equal(calls, 1);
  target = 'https://different.invalid/collect'; calls = 0;
  await assert.rejects(client.media(id, 'photo', undefined, new AbortController().signal), /outside its API/);
  assert.equal(calls, 1);
});

test('persisted settings survive a restart; validation prevents invalid files and strips extra input', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'imframe-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SettingsStore(dir); await store.load();
  await store.save({ ...defaults, name: 'Kitchen', albumIds: [albumId, albumId], unexpected: 'discard me' });
  const restarted = new SettingsStore(dir); await restarted.load();
  assert.equal(restarted.get().name, 'Kitchen');
  assert.deepEqual(restarted.get().albumIds, [albumId]);
  assert.equal((JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))).unexpected, undefined);
  await assert.rejects(store.save({ ...defaults, photoSeconds: 0 }), /photoSeconds/);
  assert.equal(store.get().name, 'Kitchen');
  assert.throws(() => parseSettings({ ...defaults, albumIds: ['invalid'] }), /valid albums/);
});

test('HTTP media proxy preserves authenticated redirects and byte-range responses without buffering the whole video', async t => {
  const requests: { path: string; range?: string; key?: string }[] = [];
  const upstream = createServer((req, res) => {
    requests.push({ path: req.url!, range: req.headers.range, key: req.headers['x-api-key'] as string });
    if (req.url!.includes('thumbnail')) { res.writeHead(302, { Location: `/api/assets/${id}/original` }); res.end(); return; }
    if (req.headers.range === 'bytes=999-') { res.writeHead(416, { 'Content-Range': 'bytes */10' }); res.end(); return; }
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 2-5/10', 'Accept-Ranges': 'bytes', 'Content-Length': '4' }); res.end('2345');
  });
  const url = await listen(upstream); t.after(() => close(upstream));
  const dir = await mkdtemp(join(tmpdir(), 'imframe-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const app = createApp({ immich: new ImmichClient(url, 'fixture-secret'), settings: new SettingsStore(dir) });
  const base = await listen(app); t.after(() => close(app));
  const response = await fetch(`${base}/api/media/${id}/photo`, { headers: { Range: 'bytes=2-5' } });
  assert.equal(response.status, 206); assert.equal(await response.text(), '2345');
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(requests.length, 2);
  assert.ok(requests.every(r => r.key === 'fixture-secret' && r.range === 'bytes=2-5'));
  const invalidRange = await fetch(`${base}/api/media/${id}/original`, { headers: { Range: 'bytes=999-' } });
  assert.equal(invalidRange.status, 416); assert.equal(invalidRange.headers.get('content-range'), 'bytes */10');
  const invalidId = await fetch(`${base}/api/media/not-an-id/original`);
  assert.equal(invalidId.status, 400);
  const invalidSettings = await fetch(`${base}/api/settings`, { method: 'PUT', body: JSON.stringify({ ...defaults, photoSeconds: -1 }) });
  assert.equal(invalidSettings.status, 400);
  assert.equal(JSON.stringify(await invalidSettings.json()).includes('fixture-secret'), false);
});

test('library refresh sees additions/removals; a deleted album is reported and settings stay intact', async t => {
  let available = true;
  let items = [id];
  const client = new ImmichClient('https://immich.invalid', 'fixture-key', (async url => {
    if (String(url).endsWith('/albums')) return Response.json(available ? [{ id: albumId, albumName: 'Family', assetCount: items.length, albumThumbnailAssetId: id }] : []);
    return Response.json({ assets: { items: items.map(assetId => ({ id: assetId, type: 'IMAGE' })), nextCursor: null } });
  }) as typeof fetch);
  const dir = await mkdtemp(join(tmpdir(), 'imframe-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = new SettingsStore(dir); await settings.save({ ...defaults, albumIds: [albumId] });
  const app = createApp({ immich: client, settings }); const base = await listen(app); t.after(() => close(app));
  const library = async () => (await fetch(`${base}/api/library?refresh=1`)).json();
  assert.equal((await library()).albums[0].media.length, 1);
  items = [];
  assert.equal((await library()).albums[0].media.length, 0);
  available = false;
  const missing = await library(); assert.equal(missing.albums.length, 0); assert.equal(missing.warnings.length, 1);
  assert.deepEqual(settings.get().albumIds, [albumId]);
});
