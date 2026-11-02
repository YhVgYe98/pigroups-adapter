// Every pane that existed in the baseline must still exist and still belong to the same
// tab. That is what "the operator's layout is untouched" means here.
import { readFileSync } from 'node:fs';
const [, , baseFile, afterFile] = process.argv;
const read = (f) => JSON.parse(readFileSync(f, 'utf8')).result.panes;
const base = read(baseFile);
const after = new Map(read(afterFile).map((p) => [p.pane_id, p]));
const problems = [];
for (const p of base) {
  const now = after.get(p.pane_id);
  if (!now) problems.push(`${p.pane_id} vanished`);
  else if (now.tab_id !== p.tab_id) problems.push(`${p.pane_id} moved ${p.tab_id} -> ${now.tab_id}`);
}
console.log(`baseline panes=${base.length} still present and in place=${base.length - problems.length}`);
console.log(problems.length === 0 ? 'ok' : `problems: ${problems.join('; ')}`);
process.exit(problems.length === 0 ? 0 : 1);
