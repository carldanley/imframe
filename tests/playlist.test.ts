import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, type Media } from '../shared/model.js';
import { buildCycle, Playlist } from '../shared/playlist.js';

const media = (id: string, date = id): Media => ({ id, type: 'IMAGE', name: id, takenAt: date, localDateTime: null, updatedAt: '', width: 4000, height: 3000, durationMs: null, mimeType: 'image/jpeg', livePhotoVideoId: null, location: null });
const settings = { ...defaults, albumIds: ['a', 'b'], mediaOrder: 'oldest' as const };

test('mixed albums have one chronological cycle, with overlapping media and Live Photo components deduplicated', () => {
  const live = { ...media('2'), livePhotoVideoId: 'motion' };
  const albums = [{ albumId: 'a', media: [media('3'), live] }, { albumId: 'b', media: [live, media('1'), { ...media('motion'), type: 'VIDEO' as const }] }];
  assert.deepEqual(buildCycle(albums, settings).map(m => m.id), ['1', '2', '3']);
});

test('album order and media order operate independently', () => {
  const albums = [{ albumId: 'a', media: [media('4'), media('2')] }, { albumId: 'b', media: [media('3'), media('1')] }];
  assert.deepEqual(buildCycle(albums, { ...settings, playbackMode: 'albums', mediaOrder: 'newest' }).map(m => m.id), ['4', '2', '3', '1']);
  assert.deepEqual(buildCycle(albums, { ...settings, playbackMode: 'albums', shuffleAlbums: true }, () => 0).map(m => m.id), ['1', '3', '2', '4']);
});

test('shuffle cycles have no repeats and avoid an immediate repeat at the cycle boundary', () => {
  const queue = new Playlist({ ...settings, mediaOrder: 'shuffle' }, () => 0.7);
  queue.update([{ albumId: 'a', media: Array.from({ length: 20 }, (_, i) => media(String(i))) }], { ...settings, mediaOrder: 'shuffle' });
  const first = Array.from({ length: 20 }, () => queue.next()!.id);
  const second = Array.from({ length: 20 }, () => queue.next()!.id);
  assert.equal(new Set(first).size, 20);
  assert.equal(new Set(second).size, 20);
  assert.notEqual(first.at(-1), second[0]);
});

test('refresh removes missing media, includes additions, and preserves progress through a cycle', () => {
  const queue = new Playlist(settings);
  queue.update([{ albumId: 'a', media: [media('1'), media('2'), media('3')] }], settings);
  assert.equal(queue.next()!.id, '1');
  queue.update([{ albumId: 'a', media: [media('1'), media('3'), media('4')] }], settings);
  assert.deepEqual([queue.next()!.id, queue.next()!.id], ['3', '4']);
  assert.equal(queue.contains('2'), false);
  queue.update([], settings);
  assert.equal(queue.next(), undefined);
});

test('album shuffling remains fixed within a cycle when the library is polled', () => {
  let random = 0;
  const config = { ...settings, playbackMode: 'albums' as const, shuffleAlbums: true };
  const queue = new Playlist(config, () => random);
  const albums = [{ albumId: 'a', media: [media('1'), media('2')] }, { albumId: 'b', media: [media('3'), media('4')] }];
  queue.update(albums, config);
  assert.equal(queue.next()!.id, '3');
  random = 0.99;
  queue.update(albums, config);
  assert.deepEqual([queue.next()!.id, queue.next()!.id, queue.next()!.id], ['4', '1', '2']);
});
