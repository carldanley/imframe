import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { MediaPrefetch } from '../shared/media-prefetch.js';

const idle = () => new AbortController().signal;
const due = () => AbortSignal.abort();

async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await delay(1);
  }
  assert.fail('Expected prefetch state was not reached.');
}

test('downloads upcoming files in order, with one request at a time, and reuses their bytes', async t => {
  const requests: string[] = [];
  let active = 0;
  const cache = new MediaPrefetch((async url => {
    requests.push(String(url));
    assert.equal(++active, 1);
    await delay(2);
    active--;
    return new Response('original pixels', { headers: { 'content-type': 'video/mp4', 'content-length': '15' } });
  }) as typeof fetch);
  t.after(() => cache.dispose());
  cache.plan(['photo', 'live-motion', 'video'], 100);
  await until(() => cache.ready('video'));
  assert.deepEqual(requests, ['photo', 'live-motion', 'video']);
  assert.equal(cache.bytes, 45);
  const file = await cache.acquire('video', idle(), due());
  assert.equal(await file?.blob.text(), 'original pixels');
  assert.equal(file?.blob.type, 'video/mp4');
  file?.release();
  cache.plan(['video'], 100);
  assert.deepEqual(requests, ['photo', 'live-motion', 'video']);
  assert.equal(cache.bytes, 15);
});

test('rejects oversized files before reading their bodies and still loads later items', async t => {
  let cancelled = false;
  const cache = new MediaPrefetch((async url => url === 'huge'
    ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': '1000' } })
    : new Response('small')) as typeof fetch);
  t.after(() => cache.dispose());
  cache.plan(['huge', 'small'], 10);
  await until(() => cache.ready('small'));
  assert.equal(cancelled, true);
  assert.equal(await cache.acquire('huge', idle(), due()), null);
  assert.equal(cache.bytes, 5);
});

test('unknown content lengths cannot exceed the cache limit', async t => {
  const cache = new MediaPrefetch((async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
      controller.close();
    },
  }))) as typeof fetch);
  t.after(() => cache.dispose());
  cache.plan(['video'], 10);
  assert.equal(await cache.acquire('video', idle(), idle()), null);
  assert.equal(cache.bytes, 0);
});

test('a due video cancels an unfinished full download and can fall back to streaming', async t => {
  let requested = false;
  let cancelled = false;
  const cache = new MediaPrefetch((async () => {
    requested = true;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  }) as typeof fetch);
  t.after(() => cache.dispose());
  cache.plan(['video'], 100);
  await until(() => requested);
  const needed = new AbortController();
  const pending = cache.acquire('video', idle(), needed.signal);
  needed.abort();
  assert.equal(await pending, null);
  assert.equal(cache.bytes, 0);
  // Test responses do not automatically abort their streams like fetch does.
  cache.dispose();
  await delay(1);
  assert.equal(cancelled, true);
});

test('removing an album cancels obsolete downloads and releases cached media', async t => {
  const aborted: string[] = [];
  const cache = new MediaPrefetch((async (url, init) => {
    if (url === 'new-photo') return new Response('new');
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted.push(String(url)); reject(new Error('aborted')); }, { once: true });
    });
  }) as typeof fetch);
  t.after(() => cache.dispose());
  cache.plan(['old-video'], 100);
  const old = cache.acquire('old-video', idle(), idle());
  cache.plan(['new-photo'], 100);
  assert.equal(await old, null);
  await until(() => cache.ready('new-photo'));
  assert.deepEqual(aborted, ['old-video']);
  assert.equal(cache.bytes, 3);
});

test('the current slide retains its file until it is released, within the shared budget', async t => {
  const cache = new MediaPrefetch((async () => new Response('12345678', { headers: { 'content-length': '8' } })) as typeof fetch);
  t.after(() => cache.dispose());
  cache.plan(['current'], 10);
  const playing = await cache.acquire('current', idle(), idle());
  assert.ok(playing);
  cache.plan(['next'], 10);
  assert.equal(await cache.acquire('next', idle(), idle()), null);
  assert.equal(await playing.blob.text(), '12345678');
  assert.equal(cache.bytes, 8);
  playing.release();
  playing.release();
  assert.equal(cache.bytes, 0);
  cache.plan(['next'], 20);
  const next = await cache.acquire('next', idle(), idle());
  assert.ok(next);
  next.release();
});

test('paused prefetch does not start requests and navigation cancels waiting consumers', async t => {
  let requests = 0;
  const cache = new MediaPrefetch((async () => { requests++; return new Response('photo'); }) as typeof fetch);
  t.after(() => cache.dispose());
  cache.pause(true);
  cache.plan(['photo'], 100);
  assert.equal(requests, 0);
  const cancel = new AbortController();
  const waiting = cache.acquire('photo', cancel.signal, idle());
  cancel.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  cache.pause(false);
  await until(() => cache.ready('photo'));
  assert.equal(requests, 1);
});

test('failed and truncated downloads fall back without serving partial files', async t => {
  const cache = new MediaPrefetch((async url => url === 'error'
    ? new Response('error', { status: 502 })
    : new Response('short', { headers: { 'content-length': '10' } })) as typeof fetch);
  t.after(() => cache.dispose());
  cache.plan(['error', 'truncated'], 100);
  assert.equal(await cache.acquire('error', idle(), idle()), null);
  assert.equal(await cache.acquire('truncated', idle(), idle()), null);
  assert.equal(cache.bytes, 0);
});
