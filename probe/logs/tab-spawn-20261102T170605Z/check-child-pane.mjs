// The child's pane is the one pane that appeared, and it belongs to the child's tab.
// Line 1 is that pane id (empty when the check fails); the rest is evidence.
import { readFileSync } from 'node:fs';
const [, , beforeFile, afterFile, rootPane, childTab] = process.argv;
const read = (f) => JSON.parse(readFileSync(f, 'utf8')).result.panes;
const before = read(beforeFile);
const after = read(afterFile);
const seen = new Set(before.map((p) => p.pane_id));
const added = after.filter((p) => !seen.has(p.pane_id) && p.pane_id !== rootPane);
const problems = [];
if (added.length !== 1) problems.push(`expected exactly one new pane, found ${added.length}: ${added.map((p) => p.pane_id).join(' ')}`);
const p = added[0];
if (p) {
  console.log(p.pane_id);
  console.log(`tab=${p.tab_id} (child tab ${childTab})`);
  console.log(`workspace=${p.workspace_id} agent=${p.agent ?? '-'} status=${p.agent_status}`);
  if (p.tab_id !== childTab) problems.push(`pane is in tab ${p.tab_id}, expected ${childTab}`);
} else {
  console.log('');
  console.log('(no new pane)');
}
console.log(problems.length === 0 ? 'ok' : `problems: ${problems.join('; ')}`);
process.exit(problems.length === 0 ? 0 : 1);
