#!/usr/bin/env node
/**
 * Re-derive the verdicts from the archived raw evidence.
 *
 * Inputs (same directory):
 *   final-session.jsonl  pi's own session file (the measurement)
 *   final-probe.jsonl    probe/boundary-probe.ts event log with epoch milliseconds
 *   summary.json         the driver's snapshot of the two phases
 *   cleanup.json         teardown evidence
 *
 * Usage: node analyze.mjs [evidence-dir]
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = process.argv[2] ?? HERE;
const readJsonl = (name) =>
  readFileSync(join(DIR, name), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const readJson = (name) => JSON.parse(readFileSync(join(DIR, name), 'utf8'));

const session = readJsonl('final-session.jsonl');
const probe = readJsonl('final-probe.jsonl');
const summary = readJson('summary.json');
const cleanup = readJson('cleanup.json');
const WINDOW_MS = 60_000;
const SLACK_MS = 2_000;

const text = (entry) => {
  if (entry.type === 'custom_message') return String(entry.content ?? '');
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .map((part) => (part.type === 'text' ? part.text ?? '' : part.type === 'thinking' ? part.thinking ?? '' : ''))
    .join('\n');
};
const toolCalls = [];
session.forEach((entry, index) => {
  if (entry.type !== 'message' || entry.message?.role !== 'assistant') return;
  for (const part of entry.message.content ?? []) {
    if (part.type === 'toolCall') toolCalls.push({ index, id: part.id, name: part.name, args: part.arguments, timestamp: entry.timestamp });
  }
});
const toolResults = [];
session.forEach((entry, index) => {
  if (entry.type !== 'message' || entry.message?.role !== 'toolResult') return;
  toolResults.push({
    index,
    toolCallId: entry.message.toolCallId,
    toolName: entry.message.toolName,
    isError: entry.message.isError === true,
    timestamp: entry.timestamp,
    text: text(entry).slice(0, 80),
  });
});
const resultFor = (call) => toolResults.find((result) => result.toolCallId === call?.id);
const customMessages = session.filter((entry) => entry.type === 'custom_message');
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;
const raw = readFileSync(join(DIR, 'final-session.jsonl'), 'utf8');
const ms = (iso) => Date.parse(iso);
const fmt = (n) => `${(n / 1000).toFixed(3)} s`;
const iso = (n) => new Date(n).toISOString();

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

for (const key of ['phaseA', 'phaseB']) {
  const phase = summary[key];
  const letter = key === 'phaseA' ? 'A' : 'B';
  const marker = phase.marker;
  const conv = phase.posted.conv;
  const seq = phase.posted.seq;
  const prefix = `[${conv}#${seq}`;
  const delivery = customMessages.filter((entry) => String(entry.content).includes(marker));
  const call = toolCalls.find((c) => c.id === phase.toolCall.id);
  const result = resultFor(call);
  const startProbe = probe.find((line) => line.step === 'tool_start' && line.toolCallId === phase.toolCall.id);
  const endProbe = probe.find((line) => line.step === 'tool_end' && line.toolCallId === phase.toolCall.id);

  console.log(`\n=== phase ${letter} — marker ${marker} ===`);
  console.log(`tool_start        ${startProbe.ts}  (${startProbe.argsPreview})`);
  console.log(`message created   ${iso(phase.posted.created_at)}  (${prefix})`);
  console.log(`window in design  ${iso(phase.posted.created_at + WINDOW_MS)}  (arrival + 60 s)`);
  console.log(`tool_end          ${endProbe.ts}  (isError=${endProbe.isError}, ${endProbe.durationMs} ms)`);
  console.log(`tool result entry ${result.timestamp}  (${JSON.stringify(result.text)})`);
  for (const entry of delivery) {
    console.log(`custom_message    ${entry.timestamp}  deliveryId=${entry.details?.deliveryId}  ${JSON.stringify(String(entry.content).slice(0, 90))}`);
  }
  const replies = [];
  session.forEach((entry) => {
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') return;
    if (text(entry).includes(marker)) replies.push(entry);
  });
  for (const entry of replies) console.log(`assistant mention ${entry.timestamp}  ${JSON.stringify(text(entry).slice(0, 90))}`);
  console.log(`occurrences of ${prefix}: ${occurrences(raw, prefix)}`);
  console.log(`occurrences of ${marker}: ${occurrences(raw, marker)} (the token is repeated inside the message text and the reply)`);

  check(
    `${letter}: exactly one delivery of ${seq}`,
    delivery.length === 1,
    `${delivery.length} custom_message(s), ${customMessages.length} custom messages in the whole session`,
  );
  check(`${letter}: the [conv#seq] marker occurs exactly once`, occurrences(raw, prefix) === 1, `${occurrences(raw, prefix)}`);
  check(`${letter}: custom_message is after the tool result`, ms(delivery[0]?.timestamp) > ms(result.timestamp), `${result.timestamp} -> ${delivery[0]?.timestamp}`);

  if (letter === 'A') {
    const spread = phase.deltas;
    console.log(
      `latency: arrival -> window close ${fmt(WINDOW_MS)}; window close -> tool result ${fmt(spread.windowClosesBeforeToolEndByMs)}; ` +
        `tool result -> delivered ${fmt(spread.toolEndToDelivered)}; arrival -> delivered ${fmt(spread.arrivalToDelivered)}; ` +
        `delivered -> assistant ${fmt(spread.deliveredToReply)}`,
    );
    check('A: the window closed while the tool was still running', phase.posted.created_at + WINDOW_MS < ms(result.timestamp), `${iso(phase.posted.created_at + WINDOW_MS)} < ${result.timestamp}`);
  } else {
    const cut = phase.abortSettled.epoch_ms;
    const startsInWindow = probe.filter((line) => line.step === 'agent_start' && line.epoch_ms > cut && line.epoch_ms < cut + WINDOW_MS);
    const messagesInWindow = customMessages.filter((entry) => ms(entry.timestamp) > cut && ms(entry.timestamp) < cut + WINDOW_MS);
    console.log(`pg.abort posted   ${phase.abortPosted.postStartIso}`);
    console.log(`cut (settled)     ${iso(cut)}  (${cut - phase.abortPosted.postStart} ms after the post)`);
    console.log(`next agent_start  ${probe.find((line) => line.step === 'agent_start' && line.epoch_ms > cut)?.ts}  (= cut + ${ms(delivery[0]?.timestamp) - cut} ms)`);
    check('B: no agent_start inside the first window after the cut', startsInWindow.length === 0, `${startsInWindow.length}`);
    check('B: no custom_message inside the first window after the cut', messagesInWindow.length === 0, `${messagesInWindow.length}`);
    check('B: delivered at least one full window after the cut', ms(delivery[0]?.timestamp) >= cut + WINDOW_MS - SLACK_MS, `cut + ${ms(delivery[0]?.timestamp) - cut} ms (window ${WINDOW_MS} ms)`);
    console.log(
      `latency: arrival -> abort post ${fmt(phase.deltas.arrivalToAbortPost)}; abort post -> cut ${fmt(phase.deltas.abortPostToCut)}; ` +
        `cut -> delivered ${fmt(phase.deltas.cutToDelivered)}; arrival -> delivered ${fmt(phase.deltas.arrivalToDelivered)}; ` +
        `delivered -> assistant ${fmt(phase.deltas.deliveredToReply)}`,
    );
  }
}

console.log('\n=== control line / abort context ===');
const controlLines = session.filter((entry) => text(entry).includes('[control'));
console.log(`entries containing "[control": ${controlLines.length} (pg.abort must not enter the context)`);
console.log(`entries containing "pg.abort": ${session.filter((entry) => JSON.stringify(entry).includes('pg.abort')).length} (system prompt tool table only)`);
check('the abort control line was not injected', controlLines.length === 0, `${controlLines.length}`);

console.log('\n=== cleanup ===');
console.log(JSON.stringify({ platform: cleanup.platform, leftover: cleanup.processesMentioningThisRun, tempDirs: cleanup.tempDirs }, null, 2));
check('the throwaway platform is gone', cleanup.platform.alive === false, `pid ${cleanup.platform.pid}`);
check('no process mentions this run\'s data dir', cleanup.processesMentioningThisRun.length === 0, `${cleanup.processesMentioningThisRun.length}`);

console.log(`\nRESULT: ${failed === 0 ? 'PASS' : `FAIL (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
