// One line per tab: id, label, pane count, agent status, workspace. Raw herdr tab list in,
// readable table out; an optional second argument keeps only that workspace.
import { readFileSync } from 'node:fs';
const [, , file, only] = process.argv;
const tabs = JSON.parse(readFileSync(file, 'utf8')).result.tabs;
for (const t of tabs) {
  if (only && t.workspace_id !== only) continue;
  console.log(`${t.tab_id}\t${t.label}\tpanes=${t.pane_count}\t${t.agent_status}\t${t.workspace_id}`);
}
