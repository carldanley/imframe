import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackHealth } from '../shared/playback-health.js';

test('retries do not inflate the skipped count; repaired and removed media stop reporting failures', () => {
  const health = new PlaybackHealth();
  const first = { id: 'one', name: 'IMG_0001.HEIC' };
  const second = { id: 'two', name: 'IMG_0002.HEIC' };
  health.failed(first, 'Full-size photo unavailable.');
  health.failed(second, 'Full-size photo unavailable.');
  health.failed(first, 'Still unavailable.');
  assert.equal(health.report().unavailableCount, 2);
  assert.equal(health.report().unavailableMedia[0]!.message, 'Still unavailable.');
  health.recovered(first.id);
  assert.deepEqual(health.report().unavailableMedia.map(item => item.id), [second.id]);
  health.retain(id => id === first.id);
  assert.deepEqual(health.report(), { unavailableCount: 0, unavailableMedia: [] });
});

test('failure reports stay bounded without losing the total or hiding remaining failures after recovery', () => {
  const health = new PlaybackHealth();
  for (let i = 0; i < 100; i++) health.failed({ id: String(i), name: `IMG_${i}.HEIC` }, 'Unavailable.');
  assert.equal(health.report().unavailableCount, 100);
  assert.equal(health.report().unavailableMedia.length, 5);
  for (let i = 0; i < 5; i++) health.recovered(String(i));
  assert.equal(health.report().unavailableCount, 95);
  assert.equal(health.report().unavailableMedia[0]!.id, '5');
});
