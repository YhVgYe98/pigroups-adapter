// Exactly one tab may be new between the two samples. It must carry the member's name
// as its label and live in the given workspace (the root's). Line 1 is the new tab id
// (empty when the check fails); the remaining lines are the evidence.
import { readFileSync } from 'node:fs';
const [, , beforeFile, afterFile, workspace, label] = process.argv;
const read = (f) => JSON.parse(readFileSync(f, 'utf8')).result.tabs;
const before = read(beforeFile);
const after = read(afterFile);
const seen = new Set(before.map((t) => t.tab_id));
const added = after.filter((t) => !seen.has(t.tab_id));
const problems = [];
if (added.length !== 1) problems.push(`expected exactly one new tab, found ${added.length}: ${added.map((t) => t.tab_id).join(' ')}`);
const t = added[0];
if (t) {
  console.log(t.tab_id);
  console.log(`label=${JSON.stringify(t.label)} (expected ${JSON.stringify(label)})`);
  console.log(`workspace=${t.workspace_id} (root workspace ${workspace})`);
  console.log(`panes=${t.pane_count} agent_status=${t.agent_status}`);
  if (t.label !== label) problems.push(`label is ${JSON.stringify(t.label)}, expected ${JSON.stringify(label)}`);
  if (t.workspace_id !== workspace) problems.push(`workspace is ${t.workspace_id}, expected ${workspace}`);
} else {
  console.log('');
  console.log('(no new tab)');
}
console.log(problems.length === 0 ? 'ok' : `problems: ${problems.join('; ')}`);
process.exit(problems.length === 0 ? 0 : 1);
