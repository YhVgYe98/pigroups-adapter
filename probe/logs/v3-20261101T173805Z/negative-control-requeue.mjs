#!/usr/bin/env node
/**
 * Negative control for case B: the same abort sequence against a scratch copy of
 * the adapter whose `requeueLastDelivered()` call is removed (src-only mutation).
 * If the live PASS in B comes from the requeue, this run must reproduce the
 * 2026-11-01 result: the marker is absent from the session JSONL entirely.
 *
 * Usage: node negative-control-requeue.mjs
 */

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = '/home/yang/Documents/pigroups-adapter';
const PG = '/home/yang/Documents/PiGroups';
const OUT = '/home/yang/Documents/pigroups-adapter/probe/logs/v3-20261101T173805Z/B-negative-control-no-requeue';
const MODEL = `${process.env.PI_PROVIDER ?? 'deepseek'}/${process.env.PI_MODEL ?? 'deepseek-flash'}`;
const WINDOW_MS = 5_000;
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const SHORT = stamp.slice(9, 15);
mkdirSync(OUT, { recursive: true });
const log = (line) => {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  appendFileSync(join(OUT, 'run.log'), text, 'utf8');
  process.stdout.write(text);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(cmd, args, opts = {}) {
  appendFileSync(join(OUT, 'commands.log'), `[${new Date().toISOString()}] ${[cmd, ...args].join(' ')}\n`, 'utf8');
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts });
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
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { parse_error: line };
      }
    });
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
  const data = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  })();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return data;
}

async function waitFor(what, fn, timeoutMs, everyMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(everyMs);
  }
  throw new Error(`timeout after ${timeoutMs} ms waiting for ${what}`);
}

function findSessionFile(dir) {
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function textOfEntry(entry) {
  if (entry.type === 'custom_message') return String(entry.content ?? '');
  if (entry.type !== 'message') return '';
  if (typeof entry.message?.content === 'string') return entry.message.content;
  return (Array.isArray(entry.message?.content) ? entry.message.content : [])
    .map((part) => (part?.type === 'text' ? part.text ?? '' : ''))
    .join('\n');
}

function analyze(path, marker) {
  const entries = readJsonl(path);
  const custom = [];
  const mentions = [];
  const relevant = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const text = textOfEntry(entry);
    if (text.includes(marker)) {
      const row = { index, type: entry.type, role: entry.message?.role, timestamp: entry.timestamp, stopReason: entry.message?.stopReason, text: text.slice(0, 1000) };
      if (entry.type === 'custom_message') custom.push(row);
      else mentions.push(row);
    }
    if (
      entry.type === 'custom_message' ||
      (entry.type === 'message' &&
        (entry.message?.role === 'toolResult' ||
          (entry.message?.role === 'assistant' &&
            ((entry.message.content ?? []).some((part) => part?.type === 'toolCall') ||
              entry.message.stopReason === 'error' ||
              entry.message.stopReason === 'aborted'))))
    ) {
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
        text: entry.type === 'custom_message' ? undefined : textOfEntry(entry).slice(0, 300),
      });
    }
  }
  return { entries, custom, mentions, relevant };
}

const PORT = await freePort();
BASE = `http://127.0.0.1:${PORT}`;
const DATA = await mkdtemp(join(tmpdir(), 'pigroups-v3neg-data.'));
const ADIR = await mkdtemp(join(tmpdir(), 'pigroups-v3neg-adir.'));
const SCRATCH = await mkdtemp(join(tmpdir(), 'pigroups-v3neg-scratch.'));

// Scratch copy with exactly one src-level mutation: no requeue on an aborted turn.
const COPY = await mkdtemp(join(tmpdir(), 'pigroups-v3neg-adapter.'));
for (const entry of readdirSync(REPO)) {
  if (entry === 'node_modules' || entry === '.git' || entry === 'probe') continue;
  cpSync(join(REPO, entry), join(COPY, entry), { recursive: true });
}
run('ln', ['-s', join(REPO, 'node_modules'), join(COPY, 'node_modules')]);
const loopPath = join(COPY, 'src', 'loop.ts');
const loopText = readFileSync(loopPath, 'utf8');
const needle = 'if (event.aborted === true) this.requeueLastDelivered();';
if (loopText.split(needle).length !== 2) throw new Error('mutation anchor not found exactly once');
writeFileSync(loopPath, loopText.replace(needle, 'if (event.aborted === true) { /* NEGATIVE CONTROL: no requeue */ }'), 'utf8');
const mutatedSha = run('sha256sum', [loopPath]).trim();
log(`scratch adapter at ${COPY}; loop.ts ${mutatedSha} (requeue removed)`);

const platformLog = join(OUT, 'platform.log');
const platformFd = (await import('node:fs')).openSync(platformLog, 'a');
const platform = spawn('node', ['src/main.ts'], {
  cwd: PG,
  env: { ...process.env, PIGROUPS_ADMIN_TOKEN: 'adm', PORT: String(PORT), PIGROUPS_DATA: DATA },
  stdio: ['ignore', platformFd, platformFd],
});
writeFileSync(join(OUT, 'platform.pid'), `${platform.pid}\n`, 'utf8');
writeFileSync(join(OUT, 'mutation.txt'), `${mutatedSha}\nrequeue removed from ${loopPath}\n`, 'utf8');

let tabId;
let paneId;
let label = `v3neg-${SHORT}`;
let cleanupDone = false;
async function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  if (paneId) {
    try {
      const info = herdr('pane', 'process-info', '--pane', paneId);
      const procs = info?.result?.process_info?.foreground_processes ?? [];
      const pid = procs.find((proc) => proc.name === 'pi')?.pid ?? procs[0]?.pid;
      if (pid) run('kill', ['-TERM', String(pid)]);
    } catch {
      // ignore
    }
  }
  if (tabId) {
    try {
      herdr('tab', 'close', tabId);
    } catch {
      // ignore
    }
  }
  try {
    platform.kill('SIGTERM');
  } catch {
    // ignore
  }
  await sleep(1000);
  try {
    platform.kill('SIGKILL');
  } catch {
    // ignore
  }
  rmSync(DATA, { recursive: true, force: true });
  rmSync(ADIR, { recursive: true, force: true });
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(COPY, { recursive: true, force: true });
}
process.on('SIGINT', async () => {
  await cleanup();
  process.exit(130);
});

try {
  await waitFor('platform health', async () => {
    try {
      return (await fetch(`${BASE}/v1/health`)).ok;
    } catch {
      return null;
    }
  }, 30000, 200);
  const boot = await api('POST', '/v1/bootstrap', undefined, { name: 'root' });
  const rootToken = boot.token;
  const created = await api('POST', '/v1/members', rootToken, { name: `v3neg-${stamp}`, request_id: `v3neg-${stamp}` });
  const member = created.member;
  const human = await api('POST', '/v1/humans', 'adm', { name: 'v3neg-human' });
  const marker = `NEG-MARK-v3-${stamp}`;
  mkdirSync(join(OUT, 'sessions'), { recursive: true });
  writeFileSync(
    join(OUT, 'ids.json'),
    `${JSON.stringify({ member, model: MODEL, windowMs: WINDOW_MS, adapter: COPY }, null, 2)}\n`,
    'utf8',
  );

  const tabOut = herdr(
    'tab', 'create', '--no-focus', '--cwd', SCRATCH, '--label', label,
    '--env', `PIGROUPS_URL=${BASE}`,
    '--env', `PIGROUPS_TOKEN=${created.token}`,
    '--env', `PIGROUPS_ADAPTER_DIR=${ADIR}`,
    '--env', `PIGROUPS_DELIVERY_WINDOW_MS=${WINDOW_MS}`,
  );
  paneId = tabOut.result.root_pane.pane_id;
  tabId = tabOut.result.tab.tab_id;
  herdr(
    'agent', 'start', label, '--kind', 'pi', '--pane', paneId, '--timeout', '60000', '--',
    '-ne', '-e', join(COPY, 'src', 'extension.ts'), '-ns', '-np', '-nc', '--no-mcp',
    '--session-dir', join(OUT, 'sessions'), '--model', MODEL,
  );
  herdr('agent', 'wait', label, '--until', 'idle', '--timeout', '120000');
  log(`member ${member.id} ready`);

  herdr('agent', 'prompt', label,
    'Call the bash tool exactly once with this exact command and no other tool: sleep 60; echo SLEEPDONE. Do not shorten the sleep. After the bash result comes back, follow the newest instruction in your context. If there is none, reply exactly READY and stop.',
    '--wait', '--until', 'working', '--timeout', '30000');
  const started = await waitFor('bash sleep in the session', () => {
    const path = findSessionFile(join(OUT, 'sessions'));
    if (!path) return null;
    const analysis = analyze(path, marker);
    const call = analysis.entries.find(
      (entry) =>
        entry.type === 'message' &&
        entry.message?.role === 'assistant' &&
        (entry.message.content ?? []).some((part) => part?.type === 'toolCall' && /sleep/.test(JSON.stringify(part.arguments ?? {}))),
    );
    return call ? { path, at: call.timestamp } : null;
  }, 90_000, 250);
  log(`tool_start at ${started.at}`);

  const sentAt = Date.now();
  await api('POST', '/v1/messages', rootToken, {
    to: member.id,
    body: `${marker}: when you next see this marker, reply with exactly "${marker}" and then stop. Do not call any tool.`,
  });
  log(`DM sent at ${new Date(sentAt).toISOString()}`);

  const journalDir = join(ADIR, 'journal', member.id);
  const delivery = await waitFor('adapter delivery into the busy turn (journal clear)', () => {
    if (!existsSync(join(ADIR, 'injected', `${member.id}.json`))) return null;
    const journal = existsSync(journalDir) ? readdirSync(journalDir).filter((name) => name.endsWith('.json')) : [];
    return journal.length === 0 ? { at: new Date().toISOString() } : null;
  }, 60_000, 100);
  log(`adapter delivery observed at ${delivery.at}; aborting 1 s later`);
  await sleep(1000);

  const abortAt = Date.now();
  await api('POST', '/v1/control', human.token, {
    to: member.id,
    id: `abort-${member.id}-${abortAt}`,
    cmd: 'pg.abort',
    payload: { v: 1 },
  });
  log(`pg.abort posted at ${new Date(abortAt).toISOString()}`);
  await sleep(20_000);

  const finalPath = findSessionFile(join(OUT, 'sessions'));
  const archived = join(OUT, 'session.jsonl');
  cpSync(finalPath, archived);
  const analysis = analyze(archived, marker);
  writeFileSync(join(OUT, 'timeline.txt'), `${analysis.relevant.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const verdict = analysis.custom.length === 0 && analysis.mentions.length === 0 ? 'LOST' : 'PRESENT';
  const summary = {
    case: 'B-negative-control-no-requeue',
    marker,
    toolStartAt: started.at,
    dmSentAt: new Date(sentAt).toISOString(),
    abortAt: new Date(abortAt).toISOString(),
    customMessages: analysis.custom,
    mentions: analysis.mentions,
    verdict,
    expectation: 'LOST, matching probe/logs/steer-20261101T170244Z/e2-native-steer-platform-abort',
    mutatedLoopSha256: mutatedSha.split(' ')[0],
  };
  writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  log(`negative control verdict: ${verdict} (custom=${analysis.custom.length} mentions=${analysis.mentions.length})`);
} finally {
  await cleanup();
}
