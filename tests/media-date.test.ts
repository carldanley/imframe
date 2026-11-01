import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTakenDate } from '../shared/model.js';

test('capture dates always use MM.DD.YY without moving to another time zone', () => {
  assert.equal(formatTakenDate('2026-01-02T00:15:00Z'), '01.02.26');
  assert.equal(formatTakenDate('2026-01-02T00:15:00+14:00'), '01.02.26');
  assert.equal(formatTakenDate('2026-12-31T23:45:00-10:00'), '12.31.26');
  assert.equal(formatTakenDate('2005-03-09'), '03.09.05');
});

test('missing and impossible calendar dates stay hidden', () => {
  for (const value of [undefined, null, '', 'unknown', '2026-02-29', '2024-02-30', '2026-04-31', '2026-00-10', '2026-13-01', '1900-02-29', '2100-02-29']) {
    assert.equal(formatTakenDate(value), null, String(value));
  }
  assert.equal(formatTakenDate('2024-02-29T12:00:00Z'), '02.29.24');
  assert.equal(formatTakenDate('2000-02-29'), '02.29.00');
});
