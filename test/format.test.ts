// §3.3/§5.2: the one stamp the adapter puts in front of a model is `YYYY-MM-DD HH:MM` in
// the host's local time. Everywhere else the expected string is computed with the same
// formatter, which cannot catch a wrong zone or a wrong field order; this file pins both.

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatLocalMinute } from '../src/format.ts';

test('formatLocalMinute renders a fixed instant in the process timezone, minute precision', () => {
  const previous = process.env.TZ;
  try {
    // 2026-11-04T17:49:00Z is 2026-11-05 01:49 in Asia/Shanghai (UTC+8): the date moves,
    // which is the difference a UTC formatter would hide.
    process.env.TZ = 'Asia/Shanghai';
    assert.equal(formatLocalMinute(Date.parse('2026-11-04T17:49:00Z')), '2026-11-05 01:49');

    // And it really is local time: the same instant in UTC keeps the date.
    process.env.TZ = 'UTC';
    assert.equal(formatLocalMinute(Date.parse('2026-11-04T17:49:00Z')), '2026-11-04 17:49');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
