// One line per pane: id, its tab, its workspace, agent and status. Optional second
// argument keeps only that workspace.
import { readFileSync } from 'node:fs';
const [, , file, only] = process.argv;
const panes = JSON.parse(readFileSync(file, 'utf8')).result.panes;
for (const p of panes) {
  if (only && p.workspace_id !== only) continue;
  console.log(`${p.pane_id}\ttab=${p.tab_id}\tws=${p.workspace_id}\tagent=${p.agent ?? '-'}\t${p.agent_status}`);
}
