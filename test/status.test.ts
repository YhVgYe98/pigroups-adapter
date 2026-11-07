// The one-line footer status: identity, root→self path, and direct-child count.
// It is UI only; none of this is model context.

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatStatus } from '../src/extension.ts';
import type { MemberStatus } from '../src/loop.ts';
import { scenario } from './scenario.ts';
import { waitFor } from './support.ts';

const theme = { bold: (value: string): string => `\u001b[1m${value}\u001b[0m` };

test('status line: bold self name, real arrow path, and kids', () => {
  const status: MemberStatus = {
    name: 'billing-api',
    id: 'm_a1b2c3',
    path: ['quant-lab', 'planner', 'billing-api'],
    childCount: 2,
  };

  assert.equal(
    formatStatus(status, theme),
    'PG \u001b[1mbilling-api\u001b[0m(m_a1b2c3) · quant-lab → planner → \u001b[1mbilling-api\u001b[0m (2 kids)',
  );
  assert.equal(
    formatStatus({ ...status, childCount: 1 }, theme),
    'PG \u001b[1mbilling-api\u001b[0m(m_a1b2c3) · quant-lab → planner → \u001b[1mbilling-api\u001b[0m (1 kid)',
  );
  assert.equal(
    formatStatus({ ...status, path: ['billing-api'], childCount: 0 }),
    'PG billing-api(m_a1b2c3) · billing-api (0 kids)',
    'no theme is plain text; a root has a one-name path',
  );
});

test('the loop reports the tree path and keeps it current after spawn', async (t) => {
  const statuses: MemberStatus[] = [];
  const s = await scenario({ role: 'child', name: 'billing-api', onStatus: (status) => statuses.push(status) });
  t.after(() => s.close());

  s.loop.start();
  await waitFor(
    () => statuses.some((status) => status.name === 'billing-api' && status.path.length === 2),
    'the root→self path to reach the status callback',
  );

  const initial = statuses.filter((status) => status.path.length === 2).at(-1);
  assert.ok(initial !== undefined);
  assert.deepEqual(initial.path, [s.parent!.name, s.me.name]);
  assert.equal(initial.childCount, 0);

  await s.loop.spawnMember({ name: 'kid', brief: 'work' });
  await waitFor(
    () => statuses.some((status) => status.name === 'billing-api' && status.childCount === 1),
    'the direct-child count to rise after spawn',
  );
});
