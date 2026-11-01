import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackClock } from '../shared/playback-clock.js';

test('photo countdown counts down in whole seconds and reaches completion without going negative', () => {
  const clock = new PlaybackClock();
  clock.startPhoto(10, 1000);
  assert.equal(clock.sample(1000)!.remainingSeconds, 10);
  assert.equal(clock.sample(2500)!.remainingSeconds, 9);
  assert.equal(clock.sample(6000)!.fraction, 0.5);
  assert.equal(clock.sample(12000)!.remainingSeconds, 0);
  assert.equal(clock.sample(12000)!.fraction, 1);
  clock.startPhoto(8, 12000);
  assert.equal(clock.sample(12000)!.fraction, 0);
  clock.clear();
  assert.equal(clock.sample(13000), null);
});

test('a buffering video does not consume countdown time, and unknown durations do not invent a countdown', () => {
  const clock = new PlaybackClock();
  clock.startVideo();
  const video = { currentTime: 4, duration: 10 };
  assert.deepEqual(clock.sample(1000, video), clock.sample(21000, video));
  assert.equal(clock.sample(21000, video)!.remainingSeconds, 6);
  assert.equal(clock.sample(21000, { ...video, currentTime: 9 })!.remainingSeconds, 1);
  assert.equal(clock.sample(21000, { ...video, duration: Infinity })!.remainingSeconds, null);
});

test('Live Photo countdown waits through motion, buffering, and the dissolve, then gives the still its full duration', () => {
  const clock = new PlaybackClock();
  clock.startLivePhoto(12);
  assert.equal(clock.sample(1000, { currentTime: 2, duration: 3 }), null);
  assert.equal(clock.sample(50000, { currentTime: 2, duration: 3 }), null);
  assert.equal(clock.sample(55000, { currentTime: 3, duration: 3 }), null);
  assert.equal(clock.sample(55300, { currentTime: 3, duration: 3 }), null);
  assert.equal(clock.holdStill(55650), 12);
  assert.deepEqual(clock.sample(55650), { elapsed: 0, duration: 12, fraction: 0, remainingSeconds: 12 });
  assert.equal(clock.sample(57650)!.remainingSeconds, 10);
  assert.equal(clock.sample(67650)!.fraction, 1);
});

test('long and interrupted Live Photo clips both leave the full configured still duration', () => {
  const clock = new PlaybackClock();
  clock.startLivePhoto(3);
  assert.equal(clock.sample(10000, { currentTime: 10, duration: 10 }), null);
  assert.equal(clock.holdStill(10650), 3);
  assert.equal(clock.sample(10650)!.remainingSeconds, 3);
  assert.equal(clock.sample(13650)!.remainingSeconds, 0);
  clock.startLivePhoto(12);
  assert.equal(clock.sample(15000, { currentTime: 1, duration: 10 }), null);
  assert.equal(clock.holdStill(15650), 12);
  assert.equal(clock.sample(15650)!.remainingSeconds, 12);
  clock.clear();
  assert.equal(clock.holdStill(16000), 0);
  assert.equal(clock.sample(16000), null);
});
