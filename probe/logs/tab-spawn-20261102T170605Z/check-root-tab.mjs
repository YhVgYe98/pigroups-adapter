// The root's tab must still hold exactly its one pane: a member in its own tab means
// no pane split beside the operator.
import { readFileSync } from 'node:fs';
const [, , beforeFile, afterFile, rootTab, rootPane] = process.argv;
const read = (f) => JSON.parse(readFileSync(f, 'utf8')).result.panes;
const before = read(beforeFile);
const after = read(afterFile);
const inBefore = before.filter((p) => p.tab_id === rootTab).map((p) => p.pane_id);
const inAfter = after.filter((p) => p.tab_id === rootTab).map((p) => p.pane_id);
const problems = [];
if (inBefore.length !== 1 || inBefore[0] !== rootPane) problems.push(`before: tab ${rootTab} held ${inBefore.join(' ') || '(nothing)'}, expected only ${rootPane}`);
if (inAfter.length !== 1 || inAfter[0] !== rootPane) problems.push(`after: tab ${rootTab} holds ${inAfter.join(' ') || '(nothing)'}, expected only ${rootPane}`);
console.log(`before=[${inBefore.join(' ')}] after=[${inAfter.join(' ')}]`);
console.log(problems.length === 0 ? 'ok' : `changed: ${problems.join('; ')}`);
process.exit(problems.length === 0 ? 0 : 1);
