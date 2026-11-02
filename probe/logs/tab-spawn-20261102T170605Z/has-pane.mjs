// Exit 0 when the pane id is in `herdr pane list`, 1 otherwise.
import { readFileSync } from 'node:fs';
const [, , file, pane] = process.argv;
const panes = JSON.parse(readFileSync(file, 'utf8')).result.panes;
process.exit(panes.some((p) => p.pane_id === pane) ? 0 : 1);
