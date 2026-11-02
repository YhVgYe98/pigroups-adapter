// Exit 0 when the tab id is in `herdr tab list`, 1 otherwise.
import { readFileSync } from 'node:fs';
const [, , file, tab] = process.argv;
const tabs = JSON.parse(readFileSync(file, 'utf8')).result.tabs;
process.exit(tabs.some((t) => t.tab_id === tab) ? 0 : 1);
