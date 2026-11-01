#!/usr/bin/env node
/**
 * Real-machine check for the multi-batch requeue fix (0.5.1, 设计说明 §3.4).
 *
 * The hole 0.5.0 shipped: `lastDelivered` held ONE batch, so two windows steered into
 * the same still-running turn meant an abort replayed only the last one. This driver
 * reproduces exactly that shape against a live platform and a live pi:
 *
 *   1. a member runs `bash: sleep 60; echo SLEEPDONE` (one turn, 60 s long);
 *   2. batch one is DM'd and the adapter steers it into that turn (watermark -> 1);
 *   3. batch two is DM'd a second window later and steered into the SAME turn
 *      (watermark -> 2), while the bash tool is still running;
 *   4. a human posts `pg.abort`; pi drops both queued steers with the aborted turn;
 *   5. the adapter must replay BOTH batches, in order, in one new custom_message —
 *      0.5.0 replayed only batch two.
 *
 * Evidence kept in this directory: platform.log, commands.log, run.log,
 * adapter-watch.jsonl (the adapter's own journal + watermark clock), session.jsonl
 * (pi's session after the abort), timeline.txt, summary.json, report.md.
 *
 * Usage: node driver.mjs [evidence-dir]
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = '/home/yang/Documents/pigroups-adapter';
const PG = '/home/yang/Documents/PiGroups';
const ADAPTER_EXT = join(REPO, 'src/extension.ts');
const MODEL = `${process.env.PI_PROVIDER ?? 'deepseek'}/${process.env.PI_MODEL ?? 'deepseek-flash'}`;
/** Same window as the v3 run: small enough to get two deliveries inside one 60 s tool. */
const WINDOW_MS = 5_000;
const TOOL_SLEEP_S = 60;

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
/** herdr agent names are lowercase-only and at most 32 characters. */
const SHORT = stamp.slice(9, 15);
const EVID = resolve(process.argv[2] ?? join(REPO, 'probe/logs', `requeue-multi-${stamp}`));
mkdirSync(EVID, { recursive: true });
const RUN_LOG = join(EVID, 'run.log');
const CMD_LOG = join(EVID, 'commands.log');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();

function logRun(line) {
  const text = `[${nowIso()}] ${line}\n`;
  appendFileSync(RUN_LOG, text, 'utf8');
  process.stdout.write(text);
}

function quote(arg) {
  return /^[A-Za-z0-9_./:=+-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function run(cmd, args, opts = {}) {
  const rendered = [cmd, ...args].map(quote).join(' ');
  appendFileSync(CMD_LOG, `[${nowIso()}] ${rendered}\n`, 'utf8');
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts });
  } catch (err) {
    logRun(`COMMAND FAILED: ${rendered}\n${err.stdout ?? ''}${err.stderr ?? ''}`);
    throw err;
  }
}

function herdr(...args) {
  const out = run('herdr', args);
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push({ parse_error: line });
    }
  }
  return out;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

let BASE;
async function api(method, path, token, body) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // keep text
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return data;
}

async function waitFor(what, fn, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(everyMs);
  }
  throw new Error(`timeout after ${timeoutMs} ms waiting for ${what}`);
}

function findSessionFile(dir) {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0];
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .map((part) => {
      if (part?.type === 'text') return part.text ?? '';
      if (part?.type === 'thinking') return part.thinking ?? '';
      if (part?.type === 'toolResult') return part.text ?? '';
      return '';
    })
    .join('\n');
}

function entryText(entry) {
  if (entry?.type === 'custom_message') return String(entry.content ?? '');
  if (entry?.type !== 'message') return '';
  return messageText(entry.message);
}

function analyze(sessionPath, markers) {
  const entries = readJsonl(sessionPath);
  const toolCalls = [];
  const toolResults = [];
  const customMessages = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type === 'custom_message') {
      customMessages.push({
        index,
        timestamp: entry.timestamp,
        customType: entry.customType,
        content: String(entry.content ?? '').slice(0, 2000),
      });
    }
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message?.role === 'assistant') {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === 'toolCall') {
          toolCalls.push({ index, id: part.id, name: part.name, args: part.arguments, timestamp: entry.timestamp });
        }
      }
    }
    if (message?.role === 'toolResult') {
      toolResults.push({
        index,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        isError: message.isError,
        durationMs: message.durationMs,
        timestamp: entry.timestamp,
        text: messageText(message).slice(0, 4000),
      });
    }
  }
  const sleepCalls = toolCalls.filter((call) => /sleep/.test(JSON.stringify(call.args ?? {})));
  const resultFor = (call) => toolResults.find((result) => result.toolCallId === call.id);
  const markerRows = {};
  for (const marker of markers) {
    const assistantMentions = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entryText(entry).includes(marker)) continue;
      if (entry.type === 'message' && entry.message?.role === 'assistant') {
        assistantMentions.push({
          index,
          timestamp: entry.timestamp,
          stopReason: entry.message.stopReason,
          text: messageText(entry.message).slice(0, 1000),
        });
      }
    }
    markerRows[marker] = {
      customMessages: customMessages.filter((row) => row.content.includes(marker)),
      assistantMentions,
    };
  }
  const relevant = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const isToolCall =
      entry.type === 'message' &&
      entry.message?.role === 'assistant' &&
      (entry.message.content ?? []).some((part) => part?.type === 'toolCall');
    const isToolResult = entry.type === 'message' && entry.message?.role === 'toolResult';
    const isCustom = entry.type === 'custom_message';
    const isErrorAssistant =
      entry.type === 'message' &&
      entry.message?.role === 'assistant' &&
      (entry.message.stopReason === 'error' || entry.message.stopReason === 'aborted' || entry.message.errorMessage);
    if (!isToolCall && !isToolResult && !isCustom && !isErrorAssistant) continue;
    relevant.push({
      index,
      type: entry.type,
      timestamp: entry.timestamp,
      role: entry.message?.role,
      toolName: entry.message?.toolName,
      isError: entry.message?.isError,
      durationMs: entry.message?.durationMs,
      stopReason: entry.message?.stopReason,
      errorMessage: entry.message?.errorMessage,
      customType: entry.customType,
      content: entry.content,
      toolCalls: isToolCall
        ? (entry.message.content ?? [])
            .filter((part) => part?.type === 'toolCall')
            .map((part) => ({ id: part.id, name: part.name, args: part.arguments }))
        : undefined,
      text: isToolResult || isErrorAssistant ? messageText(entry.message).slice(0, 1000) : undefined,
    });
  }
  return {
    sessionPath,
    entryCount: entries.length,
    sleepCalls: sleepCalls.map((call) => ({ ...call, result: resultFor(call) })),
    customMessages,
    markers: markerRows,
    relevant,
  };
}

function writeTimeline(path, analysis) {
  const lines = analysis.relevant.map((row) => JSON.stringify(row));
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

/** Poll the adapter dir: journal entries and the per-member watermark are the adapter's own clock. */
function startAdapterWatch(adir, memberId, outPath) {
  const journalDir = join(adir, 'journal', memberId);
  const injectedPath = join(adir, 'injected', `${memberId}.json`);
  let last = '';
  const timer = setInterval(() => {
    let journal = [];
    try {
      journal = readdirSync(journalDir).filter((name) => name.endsWith('.json')).sort();
    } catch {
      // not created yet
    }
    let injected = null;
    try {
      const stat = statSync(injectedPath);
      injected = { mtimeMs: stat.mtimeMs, size: stat.size, content: JSON.parse(readFileSync(injectedPath, 'utf8')) };
    } catch {
      injected = null;
    }
    const snapshot = JSON.stringify({ journal, injected });
    if (snapshot === last) return;
    last = snapshot;
    appendFileSync(
      outPath,
      `${JSON.stringify({ ts: nowIso(), epoch_ms: Date.now(), journal, injected })}\n`,
      'utf8',
    );
  }, 50);
  timer.unref?.();
  return () => clearInterval(timer);
}

function paneText(paneId, caseDir) {
  try {
    const out = run('herdr', ['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', '800']);
    writeFileSync(join(caseDir, 'pane.txt'), out, 'utf8');
  } catch (err) {
    writeFileSync(join(caseDir, 'pane.txt'), `pane read failed: ${err.message}\n`, 'utf8');
  }
}

function killPiAndCloseTab(label, paneId, tabId, caseDir) {
  let pid;
  try {
    const info = herdr('pane', 'process-info', '--pane', paneId);
    writeFileSync(join(caseDir, 'process-info.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    const procs = info?.result?.process_info?.foreground_processes ?? [];
    const pi = procs.find((proc) => proc.name === 'pi' || /(^|\/)pi$/.test(proc.argv?.[0] ?? ''));
    pid = pi?.pid ?? procs[0]?.pid;
    if (pid) run('kill', ['-TERM', String(pid)]);
  } catch (err) {
    writeFileSync(join(caseDir, 'process-info.json'), `${JSON.stringify({ error: err.message }, null, 2)}\n`, 'utf8');
  }
  if (pid) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      execFileSync('sleep', ['0.2']);
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  try {
    herdr('tab', 'close', tabId);
  } catch (err) {
    logRun(`tab close failed for ${tabId}: ${err.message}`);
    try {
      herdr('pane', 'close', paneId);
    } catch {
      // ignore
    }
  }
}

/** Create a tab+pane, start pi with THIS repo's extension, wait until idle. */
async function startMember(def, caseDir) {
  mkdirSync(join(caseDir, 'sessions'), { recursive: true });
  const envArgs = [];
  for (const [key, value] of Object.entries({
    PIGROUPS_URL: BASE,
    PIGROUPS_TOKEN: def.token,
    PIGROUPS_ADAPTER_DIR: adir,
    PIGROUPS_DELIVERY_WINDOW_MS: String(WINDOW_MS),
  })) {
    envArgs.push('--env', `${key}=${value}`);
  }
  const tabOut = herdr('tab', 'create', '--no-focus', '--cwd', scratch, '--label', def.label, ...envArgs);
  const paneId = tabOut.result.root_pane.pane_id;
  const tabId = tabOut.result.tab.tab_id;
  writeFileSync(join(caseDir, 'pane.json'), `${JSON.stringify({ paneId, tabId }, null, 2)}\n`, 'utf8');

  const startOut = herdr(
    'agent', 'start', def.label, '--kind', 'pi', '--pane', paneId, '--timeout', '60000', '--',
    '-ne', '-e', ADAPTER_EXT, '-ns', '-np', '-nc', '--no-mcp',
    '--session-dir', join(caseDir, 'sessions'), '--model', MODEL,
  );
  writeFileSync(join(caseDir, 'agent-start.json'), `${JSON.stringify(startOut, null, 2)}\n`, 'utf8');
  herdr('agent', 'wait', def.label, '--until', 'idle', '--timeout', '120000');
  logRun(`${def.label} ready in pane ${paneId} (pi -ne -e ${ADAPTER_EXT})`);
  return { paneId, tabId, sessionsDir: join(caseDir, 'sessions') };
}

function prompt(label, text, timeoutMs = 30000) {
  logRun(`prompt ${label}: ${text}`);
  return herdr('agent', 'prompt', label, text, '--wait', '--until', 'working', '--timeout', String(timeoutMs));
}

/** Prompt once; the caller's `waitFor` owns the outcome check. */
function promptStart(label, text, timeoutMs = 90000) {
  try {
    prompt(label, text, timeoutMs);
  } catch (err) {
    logRun(`prompt wait failed (continuing): ${err.message}`);
  }
}

/** The newest delivered seq for the DM, read from the adapter's own watermark file. */
function dmWatermark(row, conv) {
  const injected = row?.injected?.content?.injected;
  if (injected === undefined || injected === null) return null;
  const seq = injected[conv];
  return typeof seq === 'number' ? seq : null;
}

// ---------------------------------------------------------------------------
// The case: two batches into one turn, then an abort.
// ---------------------------------------------------------------------------
const markerOne = `MARK-ONE-${stamp}`;
const markerTwo = `MARK-TWO-${stamp}`;
const summary = { case: 'requeue-multi', markers: [markerOne, markerTwo], windowMs: WINDOW_MS, verdict: 'FAIL' };

async function caseRequeueMulti(rootToken, humanToken) {
  const caseDir = EVID;
  logRun('=== CASE: two steered batches, one aborted turn, both must be replayed ===');
  const created = await api('POST', '/v1/members', rootToken, {
    name: `rq-${stamp}`,
    request_id: `rq-${stamp}`,
  });
  const member = created.member;
  const label = `rq-${SHORT}`;
  const conv = `dm:${[member.id, rootId].sort().join('_')}`;
  Object.assign(summary, { member, conv, label });
  writeFileSync(join(caseDir, 'ids.json'), `${JSON.stringify({ member, rootId, model: MODEL, windowMs: WINDOW_MS }, null, 2)}\n`, 'utf8');

  const handles = await startMember({ label, token: created.token }, caseDir);
  const stopWatch = startAdapterWatch(adir, member.id, join(caseDir, 'adapter-watch.jsonl'));
  try {
    promptStart(
      label,
      `Call the bash tool exactly once with this exact command and no other tool: sleep ${TOOL_SLEEP_S}; echo SLEEPDONE. Do not shorten the sleep. After the bash result comes back, follow the newest instruction in your context. If there is none, reply exactly READY and stop.`,
    );
    const toolStartPath = await waitFor(
      'the bash sleep tool to start',
      () => {
        const path = findSessionFile(handles.sessionsDir);
        if (!path) return null;
        return analyze(path, [markerOne, markerTwo]).sleepCalls.length > 0 ? path : null;
      },
      120_000,
      250,
    );
    const sleepCall = analyze(toolStartPath, [markerOne, markerTwo]).sleepCalls[0];
    const toolStartMs = new Date(sleepCall.timestamp).getTime();
    logRun(`tool_start ${sleepCall.timestamp} (${JSON.stringify(sleepCall.args)})`);
    Object.assign(summary, { toolStartAt: sleepCall.timestamp, toolArgs: sleepCall.args });

    // --- batch one --------------------------------------------------------
    const sentOneAt = Date.now();
    const sentOne = await api('POST', '/v1/messages', rootToken, {
      to: member.id,
      body: `${markerOne}: when you next see this marker, reply with exactly "${markerOne}" and then stop. Do not call any tool.`,
    });
    logRun(`batch one DM sent at ${new Date(sentOneAt).toISOString()} -> seq ${sentOne.seq}`);
    const deliveryOne = await waitFor(
      'the adapter to deliver batch one into the running turn',
      () => {
        const rows = readJsonl(join(caseDir, 'adapter-watch.jsonl'));
        const row = rows.find(
          (r) => r.epoch_ms >= sentOneAt && r.journal.length === 0 && dmWatermark(r, conv) === sentOne.seq,
        );
        return row ?? null;
      },
      60_000,
      100,
    );
    logRun(
      `batch one delivered at ${deliveryOne.ts} (+${deliveryOne.epoch_ms - sentOneAt} ms, tool running) — watermark ${dmWatermark(deliveryOne, conv)}`,
    );

    // A second window has to close while the tool is still running. The delivery above
    // cleared the window; one second later a new DM opens the next one.
    await sleep(1000);
    const sentTwoAt = Date.now();
    const sentTwo = await api('POST', '/v1/messages', rootToken, {
      to: member.id,
      body: `${markerTwo}: when you next see this marker, reply with exactly "${markerTwo}" and then stop. Do not call any tool.`,
    });
    logRun(`batch two DM sent at ${new Date(sentTwoAt).toISOString()} -> seq ${sentTwo.seq}`);
    const deliveryTwo = await waitFor(
      'the adapter to deliver batch two into the SAME running turn',
      () => {
        const rows = readJsonl(join(caseDir, 'adapter-watch.jsonl'));
        const row = rows.find(
          (r) => r.epoch_ms >= sentTwoAt && r.journal.length === 0 && dmWatermark(r, conv) === sentTwo.seq,
        );
        return row ?? null;
      },
      60_000,
      100,
    );
    logRun(
      `batch two delivered at ${deliveryTwo.ts} (+${deliveryTwo.epoch_ms - sentTwoAt} ms, tool still running) — watermark ${dmWatermark(deliveryTwo, conv)}`,
    );

    // Precondition for the shape: the turn is still the same one and its tool is
    // still running, so both steers are queued behind the same tool.
    const beforeAbortPath = findSessionFile(handles.sessionsDir);
    const beforeAbort = analyze(beforeAbortPath, [markerOne, markerTwo]);
    const toolResultYet = beforeAbort.sleepCalls[0]?.result;
    const elapsed = Date.now() - toolStartMs;
    const stillRunning = toolResultYet === undefined && elapsed < TOOL_SLEEP_S * 1000;
    logRun(`before abort: elapsed=${elapsed} ms, tool result present=${toolResultYet !== undefined}, same turn=${stillRunning}`);
    Object.assign(summary, {
      adaptersDeliveriesBeforeAbort: [deliveryOne.ts, deliveryTwo.ts],
      elapsedAtAbortMs: elapsed,
      toolStillRunningAtAbort: stillRunning,
    });
    if (!stillRunning) throw new Error('the tool ended before the abort; the two deliveries did not share one turn');

    // --- abort ------------------------------------------------------------
    const abortAt = Date.now();
    const abortResponse = await api('POST', '/v1/control', humanToken, {
      to: member.id,
      id: `abort-${member.id}-${abortAt}`,
      cmd: 'pg.abort',
      payload: { v: 1 },
    });
    logRun(`pg.abort posted at ${new Date(abortAt).toISOString()} -> ${JSON.stringify(abortResponse)}`);

    // The decisive evidence: one custom_message persisted after the abort that carries
    // BOTH markers, batch one before batch two. 0.5.0 replayed batch two alone.
    const replayPath = await waitFor(
      'the replay of both batches after the abort',
      () => {
        const path = findSessionFile(handles.sessionsDir);
        if (!path) return null;
        const analysis = analyze(path, [markerOne, markerTwo]);
        const replayed = analysis.customMessages.filter(
          (row) => new Date(row.timestamp).getTime() >= abortAt && row.content.includes(markerOne),
        );
        return replayed.length > 0 ? path : null;
      },
      120_000,
      500,
    );
    await sleep(4000); // let the model answer the replayed markers
    const latest = findSessionFile(handles.sessionsDir) ?? replayPath;
    const archived = join(caseDir, 'session.jsonl');
    cpSync(latest, archived);
    const analysis = analyze(archived, [markerOne, markerTwo]);
    writeTimeline(join(caseDir, 'timeline.txt'), analysis);
    writeFileSync(join(caseDir, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');

    const replayed = analysis.customMessages.filter(
      (row) => new Date(row.timestamp).getTime() >= abortAt && row.content.includes(markerOne),
    );
    const replayText = replayed.map((row) => row.content).join('\n');
    const orderOk =
      replayText.indexOf(markerOne) !== -1 &&
      replayText.indexOf(markerTwo) !== -1 &&
      replayText.indexOf(markerOne) < replayText.indexOf(markerTwo);
    const mentionsOne = analysis.markers[markerOne].assistantMentions.filter(
      (row) => new Date(row.timestamp).getTime() >= abortAt,
    );
    const mentionsTwo = analysis.markers[markerTwo].assistantMentions.filter(
      (row) => new Date(row.timestamp).getTime() >= abortAt,
    );
    Object.assign(summary, {
      abortAt: new Date(abortAt).toISOString(),
      replayedAt: replayed.map((row) => row.timestamp),
      replayText: replayText.slice(0, 2000),
      replayHasBothInOrder: orderOk,
      assistantMentionsAfterAbort: { [markerOne]: mentionsOne.length, [markerTwo]: mentionsTwo.length },
      assistantTextAfterAbort: [...mentionsOne, ...mentionsTwo].map((row) => row.text),
    });
    // The decisive assertion is the replayed batch: one custom_message after the abort
    // holding batch one before batch two. The assistant mention is the second half —
    // proof the replayed text reached the model, not just pi's session file. The model
    // answers the newest of the two markers, so one mention is enough; both are counted.
    summary.verdict = orderOk && mentionsOne.length + mentionsTwo.length >= 1 ? 'PASS' : 'FAIL';
    logRun(
      `verdict ${summary.verdict}: replay custom_message=${replayed.length}, both markers in order=${orderOk}, assistant mentions after abort one=${mentionsOne.length} two=${mentionsTwo.length}`,
    );
  } catch (err) {
    summary.error = err.stack ?? String(err);
    logRun(`CASE ERROR: ${summary.error}`);
  } finally {
    stopWatch();
    paneText(handles.paneId, caseDir);
    killPiAndCloseTab(label, handles.paneId, handles.tabId, caseDir);
  }
  writeFileSync(join(caseDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
const PORT = await freePort();
BASE = `http://127.0.0.1:${PORT}`;
const DATA = await mkdtemp(join(tmpdir(), 'pigroups-rq-data.'));
const ADIR = await mkdtemp(join(tmpdir(), 'pigroups-rq-adir.'));
const scratch = await mkdtemp(join(tmpdir(), 'pigroups-rq-scratch.'));
const adir = ADIR;
const platformLog = join(EVID, 'platform.log');
const platformFd = openSync(platformLog, 'a');
const platform = spawn('node', ['src/main.ts'], {
  cwd: PG,
  env: { ...process.env, PIGROUPS_ADMIN_TOKEN: 'adm', PORT: String(PORT), PIGROUPS_DATA: DATA },
  stdio: ['ignore', platformFd, platformFd],
});
writeFileSync(join(EVID, 'platform.pid'), `${platform.pid}\n`, 'utf8');
const baselinePanes = herdr('pane', 'list');
writeFileSync(join(EVID, 'panes-before.json'), `${JSON.stringify(baselinePanes, null, 2)}\n`, 'utf8');
writeFileSync(
  join(EVID, 'env.sh'),
  [
    `export EVID=${quote(EVID)}`,
    `export PORT=${PORT}`,
    `export PIGROUPS_URL=${BASE}`,
    `export PIGROUPS_DATA=${quote(DATA)}`,
    `export ADIR=${quote(ADIR)}`,
    `export SCRATCH=${quote(scratch)}`,
    `export MODEL=${quote(MODEL)}`,
    `export PI_VERSION=${quote(run('pi', ['--version']).trim())}`,
    `export HEAD=${quote(run('git', ['rev-parse', 'HEAD'], { cwd: REPO }).trim())}`,
    '',
  ].join('\n'),
  'utf8',
);
logRun(`platform pid ${platform.pid} on ${BASE}, data=${DATA}, adir=${ADIR}, scratch=${scratch}`);

let rootToken;
let rootId;
let humanToken;
let cleanupDone = false;

async function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  logRun('cleanup: closing platform and removing temp dirs');
  try {
    platform.kill('SIGTERM');
  } catch {
    // ignore
  }
  await Promise.race([new Promise((resolve) => platform.once('exit', resolve)), sleep(5000)]);
  try {
    platform.kill('SIGKILL');
  } catch {
    // ignore
  }
  try {
    writeFileSync(join(EVID, 'final-panes.json'), `${JSON.stringify(herdr('pane', 'list'), null, 2)}\n`, 'utf8');
  } catch (err) {
    logRun(`pane list at cleanup failed: ${err.message}`);
  }
  rmSync(DATA, { recursive: true, force: true });
  rmSync(ADIR, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(130);
});
process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(143);
});

try {
  await waitFor(
    'platform health',
    async () => {
      try {
        const res = await fetch(`${BASE}/v1/health`);
        return res.ok;
      } catch {
        return null;
      }
    },
    30000,
    200,
  );
  const boot = await api('POST', '/v1/bootstrap', undefined, { name: 'root' });
  rootToken = boot.token;
  rootId = boot.member.id;
  writeFileSync(join(EVID, 'bootstrap.json'), `${JSON.stringify(boot, null, 2)}\n`, 'utf8');
  const human = await api('POST', '/v1/humans', 'adm', { name: 'rq-human' });
  humanToken = human.token;
  writeFileSync(join(EVID, 'human.json'), `${JSON.stringify(human, null, 2)}\n`, 'utf8');
  logRun(`bootstrapped root=${rootId}, human=${human.human?.id ?? human.id}`);

  await caseRequeueMulti(rootToken, humanToken);
} finally {
  await cleanup();
}

const panes = readJson(join(EVID, 'final-panes.json'));
const ids = (panes?.result?.panes ?? []).map((pane) => pane.pane_id).sort();
const beforeIds = (baselinePanes?.result?.panes ?? []).map((pane) => pane.pane_id).sort();
const cleanupChecks = {
  baselinePaneIds: beforeIds,
  finalPaneIds: ids,
  extraPanes: ids.filter((id) => !beforeIds.includes(id)),
  requiredPanesPresent: ['wD:p1E', 'wE:p1', 'wE:p12', 'wE:p2Q'].every((id) => ids.includes(id)),
  platformAlive: (() => {
    try {
      process.kill(platform.pid, 0);
      return true;
    } catch {
      return false;
    }
  })(),
  leftoverProbePanes: ids.filter((id) => !['wD:p1E', 'wE:p1', 'wE:p12', 'wE:p2Q'].includes(id)),
};
writeFileSync(join(EVID, 'cleanup.json'), `${JSON.stringify(cleanupChecks, null, 2)}\n`, 'utf8');
logRun(`cleanup: extraPanes=${JSON.stringify(cleanupChecks.extraPanes)} platformAlive=${cleanupChecks.platformAlive}`);
logRun(`cleanup: final panes ${ids.join(', ')}`);

process.exitCode = summary.verdict === 'PASS' && cleanupChecks.extraPanes.length === 0 ? 0 : 1;
