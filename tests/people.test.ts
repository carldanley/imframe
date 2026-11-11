import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaults, parseSettings, peopleNamesFromText, type Media } from '../shared/model.js';
import { ageWhenTaken, peopleAges } from '../shared/people.js';
import { SettingsStore } from '../server/settings.js';

const media: Media = {
  id: 'photo', type: 'IMAGE', name: 'Sample photo', takenAt: '2026-06-11T04:00:00Z',
  localDateTime: '2026-06-10T23:00:00Z', updatedAt: '', width: 1920, height: 1080,
  durationMs: null, mimeType: 'image/jpeg', livePhotoVideoId: null, location: null,
  people: [
    { id: 'alex', name: 'Alex', birthDate: '2020-06-11' },
    { id: 'shared-alex', name: 'Alex', birthDate: '2020-06-11' },
    { id: 'sam', name: 'Sam Lee', birthDate: '2025-12-10' },
    { id: 'similar', name: 'Alexandra', birthDate: '2020-01-01' },
    { id: 'missing', name: 'No birthday', birthDate: null },
  ],
};

test('ages use completed calendar years and months at capture, including infants and birthdays', () => {
  assert.equal(ageWhenTaken('2020-06-11', '2026-06-10'), '5 years, 11 months');
  assert.equal(ageWhenTaken('2020-06-11', '2026-06-11'), '6 years');
  assert.equal(ageWhenTaken('2020-06-11', '2026-07-11'), '6 years, 1 month');
  assert.equal(ageWhenTaken('2025-12-10', '2026-06-10'), '6 months');
  assert.equal(ageWhenTaken('2026-06-10', '2026-06-10'), 'Newborn');
  assert.equal(ageWhenTaken('2026-06-10', '2026-06-11'), '1 day');
  assert.equal(ageWhenTaken('2026-06-10', '2026-06-29'), '19 days');
  assert.equal(ageWhenTaken('2020-02-29', '2021-02-27'), '11 months');
  assert.equal(ageWhenTaken('2020-02-29', '2021-02-28'), '1 year');
  assert.equal(ageWhenTaken('2024-01-31', '2024-02-29'), '1 month');
  assert.equal(ageWhenTaken('2020-06-11', '2026-06-11T00:15:00+14:00'), '6 years');
});

test('missing or impossible dates and photos before birth never produce an age', () => {
  for (const birth of [null, undefined, '', 'unknown', '2025-02-29', '2020-04-31', '2027-01-01', '2020-06-11T00:00:00Z']) {
    assert.equal(ageWhenTaken(birth, '2026-06-10'), null, String(birth));
  }
  for (const capture of [null, undefined, '', '2026-02-30', 'unknown']) {
    assert.equal(ageWhenTaken('2020-06-11', capture), null, String(capture));
  }
});

test('only full allowed names appear, preserving list order and deduplicating shared profiles', () => {
  const settings = { showPeople: true, peopleNames: [' sam   lee ', 'ALEX', 'No birthday', 'alex'] };
  assert.deepEqual(peopleAges(media, settings), [{ name: 'Sam Lee', age: '6 months' }, { name: 'Alex', age: '5 years, 11 months' }]);
  assert.deepEqual(peopleAges(media, { ...settings, showPeople: false }), []);
  assert.deepEqual(peopleAges(media, { showPeople: true, peopleNames: [] }), []);
  assert.deepEqual(peopleAges(media, { showPeople: true, peopleNames: ['Sam', 'Al'] }), []);
  assert.deepEqual(peopleAges({ ...media, people: undefined }, settings), []);
  assert.deepEqual(peopleAges({ ...media, localDateTime: null }, { showPeople: true, peopleNames: ['Alex'] }), [{ name: 'Alex', age: '6 years' }]);
  assert.deepEqual(peopleAges({ ...media, type: 'VIDEO' }, settings), peopleAges(media, settings));
  assert.deepEqual(peopleAges({ ...media, livePhotoVideoId: 'motion' }, settings), peopleAges(media, settings));
});

test('different people with the same allowed name may each appear', () => {
  const sameName = { ...media, people: [{ id: 'one', name: 'Alex', birthDate: '2020-06-10' }, { id: 'two', name: 'Alex', birthDate: '2022-06-10' }] };
  assert.deepEqual(peopleAges(sameName, { showPeople: true, peopleNames: ['alex'] }), [{ name: 'Alex', age: '6 years' }, { name: 'Alex', age: '4 years' }]);
});

test('people settings migrate safely, persist per frame, and validate name lists', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'imframe-people-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { showPeople, peopleNames, peopleCorner, ...legacy } = defaults;
  await writeFile(join(dir, 'settings.json'), JSON.stringify(legacy));
  const store = new SettingsStore(dir); await store.load();
  assert.equal(store.get().showPeople, false);
  assert.deepEqual(store.get().peopleNames, []);
  assert.equal(store.get().peopleCorner, 'bottom-right');
  const names = peopleNamesFromText(' Alex \r\n\nSAM   Lee\n alex \n');
  await store.save({ showPeople: true, peopleNames: names, peopleCorner: 'top-right' }, true);
  const restarted = new SettingsStore(dir); await restarted.load();
  assert.equal(restarted.get().showPeople, true);
  assert.deepEqual(restarted.get().peopleNames, ['Alex', 'SAM Lee']);
  assert.equal(restarted.get().peopleCorner, 'top-right');
  const second = new SettingsStore(join(dir, 'other-frame')); await second.load();
  assert.deepEqual(second.get().peopleNames, []);
  assert.equal(second.get().showPeople, false);
  for (const value of [null, 'Alex', [123], ['a'.repeat(101)], Array(51).fill('Alex')]) {
    assert.throws(() => parseSettings({ ...defaults, peopleNames: value }), /people names/);
  }
  assert.throws(() => parseSettings({ ...defaults, showPeople: 'yes' }), /showPeople/);
  assert.throws(() => parseSettings({ ...defaults, peopleCorner: 'center' }), /peopleCorner/);
  assert.deepEqual(parseSettings({ ...defaults, peopleNames: ['  ', 'Élodie', 'E\u0301lodie'] }).peopleNames, ['Élodie']);
});
