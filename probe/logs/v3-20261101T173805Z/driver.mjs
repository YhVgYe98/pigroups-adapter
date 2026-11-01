#!/usr/bin/env node
/**
 * v3 real-machine verification (probe/logs/v3-<stamp>/).
 *
 * Three things the fakes cannot prove, plus the skills manifest:
 *   A. a member receives a windowed delivery while a 60 s bash tool is running and
 *      does NOT wait for idle — the adapter's own watermark/journal clock shows the
 *      send happened mid-tool, while pi persists the steer 1 ms after the tool result;
 *   B. a steered batch is not lost when an abort lands: the adapter's aborted-turn
 *      requeue re-delivers it, where the 2026-11-01 probe measured a native steer LOST;
 *   C. pg_members lists the live roster from inside a member; pg_schedule fires;
 *   D. `pi -e <package dir>` lists the two packaged skills in the startup banner.
 *
 * Usage: node driver.mjs [evidence-dir]
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = '/home/yang/Documents/pigroups-adapter';
const PG = '/home/yang/Documents/PiGroups';
const PACKAGE_DIR = REPO;
const ADAPTER_EXT = join(REPO, 'src/extension.ts');
const PROBE_EXT = join(REPO, 'probe/steer-probe.ts');
const MODEL = `${process.env.PI_PROVIDER ?? 'deepseek'}/${process.env.PI_MODEL ?? 'deepseek-flash'}`;
/** Window used in every live case: small enough to deliver mid-tool, real enough to be a window. */
const WINDOW_MS = 5_000;

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
/** herdr agent names are lowercase-only and at most 32 characters. */
const SHORT = stamp.slice(9, 15);
const EVID = process.argv[2] ?? join(REPO, 'probe/logs', `v3-${stamp}`);
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
    const allMentions = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entryText(entry).includes(marker)) continue;
      allMentions.push({
        index,
        type: entry.type,
        role: entry.message?.role,
        timestamp: entry.timestamp,
        stopReason: entry.message?.stopReason,
        text: entryText(entry).slice(0, 1000),
      });
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
      allMentions,
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
      toolCallId: entry.message?.toolCallId,
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
    firstTimestamp: entries[0]?.timestamp,
    lastTimestamp: entries[entries.length - 1]?.timestamp,
    sleepCalls: sleepCalls.map((call) => ({ ...call, result: resultFor(call) })),
    toolCalls,
    toolResults,
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
      `${JSON.stringify({
        ts: nowIso(),
        epoch_ms: Date.now(),
        journal,
        injected,
      })}\n`,
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
    writeFileSync(join(caseDir, 'process-info.json'), `${JSON.stringify({ error: err.message })}\n`, 'utf8');
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

/** Create a tab+pane, start pi, wait until idle. Returns the handles. */
async function startMember(def, caseDir) {
  mkdirSync(join(caseDir, 'trigger'), { recursive: true });
  mkdirSync(join(caseDir, 'sessions'), { recursive: true });
  const probePath = join(caseDir, 'probe.jsonl');
  writeFileSync(probePath, '', 'utf8');
  const envArgs = [];
  for (const [key, value] of Object.entries({
    PIGROUPS_URL: BASE,
    PIGROUPS_TOKEN: def.token,
    PIGROUPS_ADAPTER_DIR: adir,
    PIGROUPS_DELIVERY_WINDOW_MS: String(WINDOW_MS),
    STEER_PROBE_LOG: probePath,
    STEER_PROBE_DIR: join(caseDir, 'trigger'),
  })) {
    envArgs.push('--env', `${key}=${value}`);
  }
  const tabOut = herdr('tab', 'create', '--no-focus', '--cwd', scratch, '--label', def.label, ...envArgs);
  const paneId = tabOut.result.root_pane.pane_id;
  const tabId = tabOut.result.tab.tab_id;
  writeFileSync(join(caseDir, 'pane.json'), `${JSON.stringify({ paneId, tabId }, null, 2)}\n`, 'utf8');

  const args = [
    'agent', 'start', def.label, '--kind', 'pi', '--pane', paneId, '--timeout', '60000', '--',
    '-ne', '-e', ADAPTER_EXT, '-e', PROBE_EXT, '-ns', '-np', '-nc', '--no-mcp',
    '--session-dir', join(caseDir, 'sessions'), '--model', MODEL,
  ];
  let startOut;
  try {
    startOut = herdr(...args);
  } catch (err) {
    try {
      herdr('tab', 'close', tabId);
    } catch {
      // ignore
    }
    throw err;
  }
  writeFileSync(join(caseDir, 'agent-start.json'), `${JSON.stringify(startOut, null, 2)}\n`, 'utf8');
  herdr('agent', 'wait', def.label, '--until', 'idle', '--timeout', '120000');
  logRun(`${def.label} ready in pane ${paneId}`);
  return { paneId, tabId, probePath, sessionsDir: join(caseDir, 'sessions') };
}

function prompt(label, text, timeoutMs = 30000) {
  logRun(`prompt ${label}: ${text}`);
  return herdr('agent', 'prompt', label, text, '--wait', '--until', 'working', '--timeout', String(timeoutMs));
}

/** Prompt retried once if the session never shows `predicate`. */
async function promptUntil(label, text, sessionsDir, predicate, timeoutMs = 90_000) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      prompt(label, text);
    } catch (err) {
      logRun(`prompt wait failed (continuing): ${err.message}`);
    }
    try {
      return await waitFor('session predicate', () => {
        const path = findSessionFile(sessionsDir);
        if (!path) return null;
        return predicate(path) ? path : null;
      }, attempt === 1 ? timeoutMs : 120_000, 500);
    } catch (err) {
      logRun(`attempt ${attempt} did not satisfy: ${err.message}`);
    }
  }
  return null;
}

const summaries = [];

// ---------------------------------------------------------------------------
// A. steer delivered mid-tool, persisted at tool end (+1 ms expectation)
// ---------------------------------------------------------------------------
async function caseA(rootToken) {
  const caseDir = join(EVID, 'A-steer-midtool');
  mkdirSync(caseDir, { recursive: true });
  logRun('=== CASE A: delivery while a long tool runs ===');
  const created = await api('POST', '/v1/members', rootToken, { name: `v3a-${stamp}`, request_id: `v3a-${stamp}` });
  const member = created.member;
  const label = `v3a-${SHORT}`;
  const summary = { case: 'A-steer-midtool', member, marker: null, verdict: 'FAIL' };
  writeFileSync(join(caseDir, 'ids.json'), `${JSON.stringify({ member, model: MODEL, windowMs: WINDOW_MS }, null, 2)}\n`, 'utf8');
  const marker = `STEER-MARK-v3a-${stamp}`;
  summary.marker = marker;
  const handles = await startMember({ label, token: created.token }, caseDir);
  const stopWatch = startAdapterWatch(adir, member.id, join(caseDir, 'adapter-watch.jsonl'));
  try {
    const toolStart = await promptUntil(
      label,
      'Call the bash tool exactly once with this exact command and no other tool: sleep 60; echo SLEEPDONE. Do not shorten the sleep. After the bash result comes back, follow the newest instruction in your context. If there is none, reply exactly READY and stop.',
      handles.sessionsDir,
      (path) => analyze(path, [marker]).sleepCalls.length > 0,
    );
    if (!toolStart) throw new Error('model never started the bash sleep');
    const analysisAtStart = analyze(toolStart, [marker]);
    const sleepCall = analysisAtStart.sleepCalls[0];
    logRun(`A tool_start at ${sleepCall.timestamp} (${sleepCall.args.command})`);

    // Send the DM while the tool is running; the adapter's window then steers it in.
    const sentAt = Date.now();
    const sent = await api('POST', '/v1/messages', rootToken, {
      to: member.id,
      body: `${marker}: when you next see this marker, reply with exactly "${marker}" and then stop. Do not call any tool.`,
    });
    logRun(`A DM sent at ${new Date(sentAt).toISOString()} -> ${JSON.stringify(sent)}`);

    // The adapter's own clock: journal cleared + watermark mtime = deliver() returned.
    const delivery = await waitFor(
      'adapter delivery (journal cleared and watermark written)',
      () => {
        const rows = readJsonl(join(caseDir, 'adapter-watch.jsonl'));
        return rows.find((row) => row.epoch_ms >= sentAt && row.injected !== null && row.journal.length === 0 && row.injected.content?.injected?.[`dm:${[rootRootId, member.id].sort().join('_')}`]) ?? null;
      },
      60_000,
      100,
    ).catch(async (err) => {
      logRun(`A delivery watch did not name the DM: ${err.message}; falling back to watermark mtime`);
      const rows = readJsonl(join(caseDir, 'adapter-watch.jsonl'));
      const written = rows.find((row) => row.epoch_ms >= sentAt && row.injected !== null && row.journal.length === 0);
      if (!written) throw err;
      return written;
    });
    logRun(`A adapter delivery observed at ${delivery.ts} (${delivery.epoch_ms - sentAt} ms after the DM)`);

    // Wait until the assistant has seen the marker (after the 60 s tool returns).
    const finalPath = await waitFor(
      'assistant mention of the marker',
      () => {
        const path = findSessionFile(handles.sessionsDir);
        if (!path) return null;
        const analysis = analyze(path, [marker]);
        return analysis.markers[marker].assistantMentions.length > 0 ? path : null;
      },
      150_000,
      500,
    );
    const archived = join(caseDir, 'session.jsonl');
    cpSync(finalPath, archived);
    const analysis = analyze(archived, [marker]);
    writeTimeline(join(caseDir, 'timeline.txt'), analysis);
    writeFileSync(join(caseDir, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');

    const toolResult = analysis.sleepCalls[0]?.result;
    const custom = analysis.markers[marker].customMessages[0];
    const mention = analysis.markers[marker].assistantMentions[0];
    const deliveryToToolStart = sleepCallTimestampMs(sleepCall) === null ? null : delivery.epoch_ms - new Date(sleepCall.timestamp).getTime();
    const resultToCustomMs = toolResult && custom ? new Date(custom.timestamp).getTime() - new Date(toolResult.timestamp).getTime() : null;
    Object.assign(summary, {
      toolStartAt: sleepCall.timestamp,
      dmSentAt: new Date(sentAt).toISOString(),
      adapterDeliveryAt: delivery.ts,
      adapterDeliveryBeforeToolResultByMs:
        toolResult ? new Date(toolResult.timestamp).getTime() - delivery.epoch_ms : null,
      deliveryToToolStartMs: deliveryToToolStart,
      toolResultAt: toolResult?.timestamp ?? null,
      toolResultDurationMs: toolResult?.durationMs ?? null,
      persistedCustomMessageAt: custom?.timestamp ?? null,
      customMinusToolResultMs: resultToCustomMs,
      assistantMentionAt: mention?.timestamp ?? null,
      customMessageContent: custom?.content ?? null,
      assistantText: mention?.text ?? null,
    });
    summary.verdict =
      custom &&
      toolResult &&
      delivery.epoch_ms < new Date(toolResult.timestamp).getTime() - 30_000 &&
      resultToCustomMs !== null &&
      resultToCustomMs >= 0 &&
      resultToCustomMs <= 2000 &&
      mention
        ? 'PASS'
        : 'FAIL';
    logRun(
      `A verdict ${summary.verdict}: delivery ${delivery.ts} was ${summary.adapterDeliveryBeforeToolResultByMs} ms before the tool result (${toolResult?.timestamp}); custom_message at ${custom?.timestamp} (${resultToCustomMs} ms after result); mention ${mention?.timestamp}`,
    );
  } catch (err) {
    summary.error = err.stack ?? String(err);
    logRun(`CASE A ERROR: ${summary.error}`);
  } finally {
    stopWatch();
    paneText(handles.paneId, caseDir);
    killPiAndCloseTab(label, handles.paneId, handles.tabId, caseDir);
  }
  writeFileSync(join(caseDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  summaries.push(summary);
  return summary;
}

function sleepCallTimestampMs(call) {
  const time = new Date(call.timestamp).getTime();
  return Number.isFinite(time) ? time : null;
}

// ---------------------------------------------------------------------------
// B. abort must not lose the steered batch (the 2026-11-01 native arm lost it)
// ---------------------------------------------------------------------------
async function caseB(rootToken, humanToken) {
  const caseDir = join(EVID, 'B-abort-requeue');
  mkdirSync(caseDir, { recursive: true });
  logRun('=== CASE B: abort after a queued steer ===');
  const created = await api('POST', '/v1/members', rootToken, { name: `v3b-${stamp}`, request_id: `v3b-${stamp}` });
  const member = created.member;
  const label = `v3b-${SHORT}`;
  const marker = `ABORT-MARK-v3b-${stamp}`;
  const summary = { case: 'B-abort-requeue', member, marker, verdict: 'FAIL' };
  writeFileSync(join(caseDir, 'ids.json'), `${JSON.stringify({ member, model: MODEL, windowMs: WINDOW_MS }, null, 2)}\n`, 'utf8');
  const handles = await startMember({ label, token: created.token }, caseDir);
  const stopWatch = startAdapterWatch(adir, member.id, join(caseDir, 'adapter-watch.jsonl'));
  try {
    const toolStartPath = await promptUntil(
      label,
      'Call the bash tool exactly once with this exact command and no other tool: sleep 60; echo SLEEPDONE. Do not shorten the sleep. After the bash result comes back, follow the newest instruction in your context. If there is none, reply exactly READY and stop.',
      handles.sessionsDir,
      (path) => analyze(path, [marker]).sleepCalls.length > 0,
    );
    if (!toolStartPath) throw new Error('model never started the bash sleep');
    const beforeAnalysis = analyze(toolStartPath, [marker]);
    const sleepCall = beforeAnalysis.sleepCalls[0];
    logRun(`B tool_start at ${sleepCall.timestamp}`);

    const sentAt = Date.now();
    const sent = await api('POST', '/v1/messages', rootToken, {
      to: member.id,
      body: `${marker}: when you next see this marker, reply with exactly "${marker}" and then stop. Do not call any tool.`,
    });
    logRun(`B DM sent at ${new Date(sentAt).toISOString()} -> ${JSON.stringify(sent)}`);

    // Wait for the adapter to have delivered into the busy turn (journal cleared).
    const delivery = await waitFor(
      'adapter delivery before the abort',
      () => {
        const rows = readJsonl(join(caseDir, 'adapter-watch.jsonl'));
        return rows.find((row) => row.epoch_ms >= sentAt && row.injected !== null && row.journal.length === 0) ?? null;
      },
      60_000,
      100,
    );
    logRun(`B adapter delivery observed at ${delivery.ts} (${delivery.epoch_ms - sentAt} ms after the DM, tool still running)`);
    await sleep(1000);

    const abortAt = Date.now();
    const abortResponse = await api('POST', '/v1/control', humanToken, {
      to: member.id,
      id: `abort-${member.id}-${abortAt}`,
      cmd: 'pg.abort',
      payload: { v: 1 },
    });
    logRun(`B pg.abort posted at ${new Date(abortAt).toISOString()} -> ${JSON.stringify(abortResponse)}`);

    // The session must eventually contain the marker: a custom_message persisted
    // after the abort (the requeued batch) and/or an assistant mention of it.
    const finalPath = await waitFor(
      'marker persisted or mentioned after the abort',
      () => {
        const path = findSessionFile(handles.sessionsDir);
        if (!path) return null;
        const analysis = analyze(path, [marker]);
        const row = analysis.markers[marker];
        return row.customMessages.length > 0 || row.assistantMentions.length > 0 ? path : null;
      },
      120_000,
      500,
    );
    // Give the model a moment to answer the re-delivered marker.
    await sleep(3000);
    const latest = findSessionFile(handles.sessionsDir);
    const archived = join(caseDir, 'session.jsonl');
    cpSync(latest ?? finalPath, archived);
    const analysis = analyze(archived, [marker]);
    writeTimeline(join(caseDir, 'timeline.txt'), analysis);
    writeFileSync(join(caseDir, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');

    const custom = analysis.markers[marker].customMessages;
    const mentions = analysis.markers[marker].assistantMentions;
    const persistedAfterAbort = custom.filter((row) => new Date(row.timestamp).getTime() >= abortAt);
    const mentionsAfterAbort = mentions.filter((row) => new Date(row.timestamp).getTime() >= abortAt);
    Object.assign(summary, {
      toolStartAt: sleepCall.timestamp,
      dmSentAt: new Date(sentAt).toISOString(),
      adapterDeliveryAt: delivery.ts,
      abortAt: new Date(abortAt).toISOString(),
      customMessages: custom,
      assistantMentions: mentions,
      persistedAfterAbort: persistedAfterAbort.length,
      mentionsAfterAbort: mentionsAfterAbort.length,
      redeliveredText: persistedAfterAbort[0]?.content ?? null,
      assistantText: mentionsAfterAbort[0]?.text ?? null,
    });
    summary.verdict = persistedAfterAbort.length >= 1 && mentionsAfterAbort.length >= 1 ? 'PASS' : 'FAIL';
    logRun(
      `B verdict ${summary.verdict}: custom_message after abort=${persistedAfterAbort.length}, assistant mention after abort=${mentionsAfterAbort.length}, first=${persistedAfterAbort[0]?.timestamp ?? '—'}`,
    );
  } catch (err) {
    summary.error = err.stack ?? String(err);
    logRun(`CASE B ERROR: ${summary.error}`);
  } finally {
    stopWatch();
    paneText(handles.paneId, caseDir);
    killPiAndCloseTab(label, handles.paneId, handles.tabId, caseDir);
  }
  writeFileSync(join(caseDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  summaries.push(summary);
  return summary;
}

// ---------------------------------------------------------------------------
// C. pg_members against the live roster, pg_schedule against the live tick
// ---------------------------------------------------------------------------
async function caseC(rootToken) {
  const caseDir = join(EVID, 'C-members-schedule');
  mkdirSync(caseDir, { recursive: true });
  logRun('=== CASE C: pg_members + pg_schedule on a live platform ===');
  const created = await api('POST', '/v1/members', rootToken, { name: `v3c-${stamp}`, request_id: `v3c-${stamp}` });
  const member = created.member;
  // A child of v3c and one more child of root, so the roster has all four relations.
  const worker = await api('POST', '/v1/members', created.token, { name: `v3c-worker-${stamp}`, request_id: `v3c-worker-${stamp}` });
  await api('POST', '/v1/members', rootToken, { name: `v3c-sibling-${stamp}`, request_id: `v3c-sibling-${stamp}` });
  const label = `v3c-${SHORT}`;
  const schedMarker = `SCHED-MARK-v3c-${stamp}`;
  const summary = { case: 'C-members-schedule', member, worker: worker.member, marker: schedMarker, verdict: 'FAIL' };
  writeFileSync(
    join(caseDir, 'ids.json'),
    `${JSON.stringify({ member, worker: worker.member, model: MODEL, windowMs: WINDOW_MS }, null, 2)}\n`,
    'utf8',
  );
  const handles = await startMember({ label, token: created.token }, caseDir);
  try {
    // --- pg_members ---
    const rosterPath = await promptUntil(
      label,
      'Call the pg_members tool exactly once with no query. Then reply with exactly ROSTER-DONE and stop. Do not call any other tool.',
      handles.sessionsDir,
      (path) => analyze(path, [schedMarker]).toolResults.some((result) => result.toolName === 'pg_members'),
    );
    if (!rosterPath) throw new Error('model never called pg_members');
    const rosterAnalysis = analyze(rosterPath, [schedMarker]);
    const rosterResult = rosterAnalysis.toolResults.find((result) => result.toolName === 'pg_members');
    let roster = null;
    try {
      roster = JSON.parse(rosterResult.text);
    } catch {
      // keep the raw text
    }
    const rosterRows = roster?.members ?? [];
    const rowFor = (id) => rosterRows.find((row) => row.id === id);
    const selfRow = rowFor(member.id);
    const parentRow = rowFor(rootRootId);
    const childRow = rowFor(worker.member.id);
    const siblingRow = rosterRows.find((row) => row.relation === 'sibling');
    Object.assign(summary, {
      rosterToolResultAt: rosterResult.timestamp,
      rosterText: rosterResult.text,
      rosterSelf: roster?.self ?? null,
      rosterTotal: roster?.total ?? null,
      rosterMatched: roster?.matched ?? null,
      rosterRowCount: rosterRows.length,
      selfRelation: selfRow?.relation ?? null,
      parentRelation: parentRow?.relation ?? null,
      childRelation: childRow?.relation ?? null,
      siblingRelation: siblingRow?.relation ?? null,
      childParentName: childRow?.parent_name ?? null,
      childLastSeenAt: childRow?.last_seen_at ?? null,
    });
    logRun(
      `C pg_members: total=${roster?.total} matched=${roster?.matched} rows=${rosterRows.length} self=${selfRow?.relation} parent=${parentRow?.relation} child=${childRow?.relation} sibling=${siblingRow?.relation}`,
    );

    // --- pg_schedule ---
    const schedPath = await promptUntil(
      label,
      `Call the pg_schedule tool exactly once with after_seconds 10 and note "${schedMarker}: reply with exactly ${schedMarker} and stop". Then reply with exactly SCHED-DONE and stop. Do not call any other tool.`,
      handles.sessionsDir,
      (path) => analyze(path, [schedMarker]).toolResults.some((result) => result.toolName === 'pg_schedule'),
    );
    if (!schedPath) throw new Error('model never called pg_schedule');
    const schedAnalysis = analyze(schedPath, [schedMarker]);
    const schedResult = schedAnalysis.toolResults.find((result) => result.toolName === 'pg_schedule');
    const scheduleCallAt = schedResult.timestamp;
    Object.assign(summary, {
      scheduleToolResultAt: scheduleCallAt,
      scheduleToolText: schedResult.text,
    });
    logRun(`C pg_schedule returned at ${scheduleCallAt}: ${schedResult.text}`);

    const firedPath = await waitFor(
      'the scheduled wake to arrive in the session',
      () => {
        const path = findSessionFile(handles.sessionsDir);
        if (!path) return null;
        const analysis = analyze(path, [schedMarker]);
        const custom = analysis.markers[schedMarker].customMessages.find((row) =>
          row.content.startsWith('[scheduled]'),
        );
        return custom ?? null;
      },
      150_000,
      500,
    ).catch(() => null);
    if (firedPath) {
      await sleep(2000);
      const latest = findSessionFile(handles.sessionsDir);
      const archived = join(caseDir, 'session.jsonl');
      cpSync(latest, archived);
      const analysis = analyze(archived, [schedMarker]);
      writeTimeline(join(caseDir, 'timeline.txt'), analysis);
      writeFileSync(join(caseDir, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
      const custom = analysis.markers[schedMarker].customMessages.find((row) => row.content.startsWith('[scheduled]'));
      const mention = analysis.markers[schedMarker].assistantMentions[0];
      Object.assign(summary, {
        scheduledDeliveredAt: custom?.timestamp ?? null,
        scheduledContent: custom?.content ?? null,
        scheduledFireDelayMs: custom ? new Date(custom.timestamp).getTime() - new Date(scheduleCallAt).getTime() : null,
        scheduledMentionAt: mention?.timestamp ?? null,
        scheduledAssistantText: mention?.text ?? null,
      });
    } else {
      const latest = findSessionFile(handles.sessionsDir);
      if (latest) {
        const archived = join(caseDir, 'session.jsonl');
        cpSync(latest, archived);
        writeTimeline(join(caseDir, 'timeline.txt'), analyze(archived, [schedMarker]));
      }
      logRun('C pg_schedule did not deliver within 150 s');
    }

    const rosterOk =
      roster !== null &&
      selfRow?.relation === 'self' &&
      parentRow?.relation === 'parent' &&
      childRow?.relation === 'child' &&
      siblingRow?.relation === 'sibling' &&
      childRow?.parent_name === member.name &&
      typeof roster.total === 'number' &&
      roster.total >= 6;
    const scheduleOk = Boolean(summary.scheduledContent?.startsWith('[scheduled]') && summary.scheduledMentionAt);
    summary.rosterOk = rosterOk;
    summary.scheduleOk = scheduleOk;
    summary.verdict = rosterOk && scheduleOk ? 'PASS' : 'FAIL';
    logRun(`C verdict ${summary.verdict}: rosterOk=${rosterOk} scheduleOk=${scheduleOk} fired=${summary.scheduledDeliveredAt ?? '—'}`);
  } catch (err) {
    summary.error = err.stack ?? String(err);
    logRun(`CASE C ERROR: ${summary.error}`);
  } finally {
    paneText(handles.paneId, caseDir);
    killPiAndCloseTab(label, handles.paneId, handles.tabId, caseDir);
  }
  writeFileSync(join(caseDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  summaries.push(summary);
  return summary;
}

// ---------------------------------------------------------------------------
// D. the package manifest's skills are discovered by pi itself
// ---------------------------------------------------------------------------
async function caseD() {
  const caseDir = join(EVID, 'D-skills-banner');
  mkdirSync(caseDir, { recursive: true });
  logRun('=== CASE D: pi -e <package dir> lists the two skills ===');
  const label = `v3d-${SHORT}`;
  const summary = { case: 'D-skills-banner', verdict: 'FAIL' };
  mkdirSync(join(caseDir, 'sessions'), { recursive: true });
  const tabOut = herdr(
    'tab',
    'create',
    '--no-focus',
    '--cwd',
    scratch,
    '--label',
    label,
  );
  const paneId = tabOut.result.root_pane.pane_id;
  const tabId = tabOut.result.tab.tab_id;
  writeFileSync(join(caseDir, 'pane.json'), `${JSON.stringify({ paneId, tabId }, null, 2)}\n`, 'utf8');
  try {
    const startOut = herdr(
      'agent',
      'start',
      label,
      '--kind',
      'pi',
      '--pane',
      paneId,
      '--timeout',
      '60000',
      '--',
      '-ne',
      '-e',
      PACKAGE_DIR,
      '-np',
      '-nc',
      '--no-mcp',
      '--session-dir',
      join(caseDir, 'sessions'),
      '--model',
      MODEL,
    );
    writeFileSync(join(caseDir, 'agent-start.json'), `${JSON.stringify(startOut, null, 2)}\n`, 'utf8');
    await sleep(5000);
    const pane = run('herdr', ['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', '800']);
    writeFileSync(join(caseDir, 'pane.txt'), pane, 'utf8');
    const skillsSection = pane.split('[Skills]')[1]?.split('\n\n')[0] ?? '';
    const hasOrg = /pigroups-org/.test(skillsSection);
    const hasMessage = /pigroups-message/.test(skillsSection);
    Object.assign(summary, {
      skillsSection: skillsSection.trim(),
      hasOrg,
      hasMessage,
      packageDir: PACKAGE_DIR,
      invocation: `pi -ne -e ${PACKAGE_DIR} -np -nc --no-mcp --session-dir ... --model ${MODEL}`,
      extensionSection: pane.split('[Extensions]')[1]?.split('\n\n')[0]?.trim() ?? '',
    });
    summary.verdict = hasOrg && hasMessage ? 'PASS' : 'FAIL';
    logRun(`D verdict ${summary.verdict}: [Skills] ${summary.skillsSection}`);
  } catch (err) {
    summary.error = err.stack ?? String(err);
    logRun(`CASE D ERROR: ${summary.error}`);
  } finally {
    paneText(paneId, caseDir);
    killPiAndCloseTab(label, paneId, tabId, caseDir);
  }
  writeFileSync(join(caseDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  summaries.push(summary);
  return summary;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
const PORT = await freePort();
BASE = `http://127.0.0.1:${PORT}`;
const DATA = await mkdtemp(join(tmpdir(), 'pigroups-v3-data.'));
const ADIR = await mkdtemp(join(tmpdir(), 'pigroups-v3-adir.'));
const scratch = await mkdtemp(join(tmpdir(), 'pigroups-v3-scratch.'));
const adir = ADIR;
const platformLog = join(EVID, 'platform.log');
const platformFd = (await import('node:fs')).openSync(platformLog, 'a');
const platform = spawn('node', ['src/main.ts'], {
  cwd: PG,
  env: { ...process.env, PIGROUPS_ADMIN_TOKEN: 'adm', PORT: String(PORT), PIGROUPS_DATA: DATA },
  stdio: ['ignore', platformFd, platformFd],
});
writeFileSync(join(EVID, 'platform.pid'), `${platform.pid}\n`, 'utf8');
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
let rootRootId;
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
  await waitFor('platform health', async () => {
    try {
      const res = await fetch(`${BASE}/v1/health`);
      return res.ok;
    } catch {
      return null;
    }
  }, 30000, 200);
  const boot = await api('POST', '/v1/bootstrap', undefined, { name: 'root' });
  rootToken = boot.token;
  rootRootId = boot.member.id;
  writeFileSync(join(EVID, 'bootstrap.json'), `${JSON.stringify(boot, null, 2)}\n`, 'utf8');
  const human = await api('POST', '/v1/humans', 'adm', { name: 'v3-human' });
  humanToken = human.token;
  writeFileSync(join(EVID, 'human.json'), `${JSON.stringify(human, null, 2)}\n`, 'utf8');
  logRun(`bootstrapped root=${rootRootId}, human=${human.human?.id ?? human.id}`);

  await caseA(rootToken);
  await caseB(rootToken, humanToken);
  await caseC(rootToken);
  await caseD();
  writeFileSync(join(EVID, 'summaries.json'), `${JSON.stringify(summaries, null, 2)}\n`, 'utf8');
  logRun('all cases done');
} finally {
  await cleanup();
}

const panes = readJson(join(EVID, 'final-panes.json'));
const ids = (panes?.result?.panes ?? []).map((pane) => pane.pane_id).sort();
const cleanupChecks = {
  finalPaneIds: ids,
  extraPanes: ids.filter((id) => !['wD:p1E', 'wE:p1', 'wE:p12', 'wE:p2Q'].includes(id)),
  platformPid: platform.pid,
  platformAlive: (() => {
    try {
      process.kill(platform.pid, 0);
      return true;
    } catch {
      return false;
    }
  })(),
};
writeFileSync(join(EVID, 'cleanup.json'), `${JSON.stringify(cleanupChecks, null, 2)}\n`, 'utf8');
logRun(
  `cleanup: final panes=${cleanupChecks.finalPaneIds.join(' ')}; extra=${cleanupChecks.extraPanes.join(' ') || 'none'}; platformAlive=${cleanupChecks.platformAlive}`,
);

const rows = summaries.map((s) => {
  if (s.case.startsWith('A')) {
    return `| ${s.case} | ${s.verdict} | ${s.adapterDeliveryAt ?? '—'} | ${s.toolResultAt ?? '—'} | ${s.customMinusToolResultMs ?? '—'} ms | ${s.assistantMentionAt ?? '—'} |`;
  }
  if (s.case.startsWith('B')) {
    return `| ${s.case} | ${s.verdict} | ${s.abortAt ?? '—'} | ${s.persistedAfterAbort ?? '—'} | ${s.mentionsAfterAbort ?? '—'} | ${s.redeliveredText ? 'yes' : 'no'} |`;
  }
  if (s.case.startsWith('C')) {
    return `| ${s.case} | ${s.verdict} | total ${s.rosterTotal ?? '—'} / matched ${s.rosterMatched ?? '—'} | self=${s.selfRelation ?? '—'} parent=${s.parentRelation ?? '—'} child=${s.childRelation ?? '—'} sibling=${s.siblingRelation ?? '—'} | ${s.scheduledFireDelayMs ?? '—'} ms | ${s.scheduledMentionAt ?? '—'} |`;
  }
  return `| ${s.case} | ${s.verdict} | ${s.skillsSection?.replace(/\n/g, ' ') ?? '—'} | — | — | — |`;
});
const md = [
  `# v3 real-machine verification ${stamp}`,
  '',
  `pi ${run('pi', ['--version']).trim()}, adapter HEAD ${run('git', ['rev-parse', 'HEAD'], { cwd: REPO }).trim()}, model ${MODEL}.`,
  `Platform ${BASE} (throwaway; pid in platform.pid). Delivery window ${WINDOW_MS} ms in every live case.`,
  '',
  '| case | verdict | key timestamp | detail | detail 2 | detail 3 |',
  '|---|---|---|---|---|---|',
  ...rows,
  '',
  'Raw evidence per case: `probe.jsonl`, `adapter-watch.jsonl`, `session.jsonl`, `timeline.txt`, `summary.json`, `pane.txt`.',
  '',
].join('\n');
writeFileSync(join(EVID, 'README.md'), md, 'utf8');
logRun('wrote README.md');
