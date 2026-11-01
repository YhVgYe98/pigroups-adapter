/**
 * Pi extension entry point (设计说明 §1, §8).
 *
 * This file only translates: `pi.registerTool` → `AdapterLoop` methods, pi
 * session events → `PiSurface`. All the behaviour lives in `loop.ts`.
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AdapterLoop } from './loop.ts';
import type { LoopConfig } from './loop.ts';
import { HerdrCli } from './herdr.ts';
import { PgClient } from './pgclient.ts';
import { PiSurfaceAdapter } from './surface.ts';
import type { PiLike, PiToolDefinition } from './surface.ts';
import { ADAPTER_VERSION } from './version.ts';

const EXIT_REPORT_TIMEOUT_MS = 2000;
const INSPECT_TIMEOUT_MS = 10_000;

export default function pigroupsExtension(pi: PiLike): void {
  // §7: the same extension is installed in every session; only members pull.
  const config = readConfig();
  if (!config) return;

  const surface = new PiSurfaceAdapter(pi);
  const pg = new PgClient({ url: config.url, token: config.token });
  const herdr = new HerdrCli({ spawnCmd: config.spawnCmd });

  let loop: AdapterLoop | undefined;

  for (const tool of buildTools(() => loop, pg, surface)) pi.registerTool(tool);

  pi.on('session_start', (_event, ctx) => {
    surface.attachContext(ctx);
    if (loop) return;
    // The one startup line: which adapter this member is running, and against what.
    console.log(`[pigroups] adapter ${ADAPTER_VERSION} starting against ${config.url}`);
    loop = new AdapterLoop({ pg, surface, herdr, config, now: () => Date.now() });
    loop.start();
  });

  pi.on('session_shutdown', async () => {
    const active = loop;
    if (!active) return;
    loop = undefined;
    await reportExiting(pg);
    await active.stop();
  });
}

function readConfig(): LoopConfig | null {
  const url = process.env.PIGROUPS_URL;
  const token = process.env.PIGROUPS_TOKEN;
  if (!url || !token) return null;

  return {
    url,
    token,
    adapterDir: process.env.PIGROUPS_ADAPTER_DIR ?? join(homedir(), '.pigroups-adapter'),
    pollLimit: envInt('PIGROUPS_POLL_LIMIT', 20),
    pollWait: envInt('PIGROUPS_POLL_WAIT', 25),
    attentionToolMs: envInt('PIGROUPS_ATTENTION_TOOL_MS', 300_000),
    remindWindowMs: envInt('PIGROUPS_REMIND_WINDOW_MS', 300_000),
    nudgeMax: envInt('PIGROUPS_NUDGE_MAX', 3),
    spawnCmd: process.env.PIGROUPS_SPAWN_CMD ?? 'pi',
  };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** §8: best effort, two seconds, then give up. */
async function reportExiting(pg: PgClient): Promise<void> {
  try {
    const who = await withTimeout(pg.whoami(), EXIT_REPORT_TIMEOUT_MS);
    const parent = who.member.parent_id;
    if (!parent) return;
    await withTimeout(
      pg.sendControl({
        to: parent,
        id: randomUUID(),
        cmd: 'pg.report',
        payload: { v: 1, status: 'blocked', text: 'exiting' },
      }),
      EXIT_REPORT_TIMEOUT_MS,
    );
  } catch {
    // Nothing to do: the process is going away either way.
  }
}

function buildTools(
  getLoop: () => AdapterLoop | undefined,
  pg: PgClient,
  surface: PiSurfaceAdapter,
): PiToolDefinition[] {
  const requireLoop = (): AdapterLoop => {
    const loop = getLoop();
    if (!loop) throw new Error('pigroups adapter is not running in this session');
    return loop;
  };

  return [
    {
      name: 'pg_children',
      label: 'PiGroups children',
      description: 'Telemetry snapshot of this member’s direct children (state, since, tool, count).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => text(JSON.stringify(requireLoop().children(), null, 2)),
    },
    {
      name: 'pg_inspect',
      label: 'PiGroups inspect',
      description: 'Ask a member (usually a direct child) for its current phase, tool, owed replies and children.',
      parameters: {
        type: 'object',
        properties: { member: { type: 'string', description: 'Member id to inspect.' } },
        required: ['member'],
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        const member = String(params.member);
        const result = await requireLoop().inspect(member, INSPECT_TIMEOUT_MS);
        return text(JSON.stringify(result, null, 2));
      },
    },
    {
      name: 'pg_abort',
      label: 'PiGroups abort',
      description: 'Send pg.abort to a member, or cut this session’s own running turn when no member is given.',
      parameters: {
        type: 'object',
        properties: { member: { type: 'string', description: 'Member id; omit to abort yourself.' } },
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        const member = typeof params.member === 'string' ? params.member : undefined;
        if (!member) {
          await surface.abort();
          return text('aborted');
        }
        await pg.sendControl({ to: member, id: randomUUID(), cmd: 'pg.abort', payload: { v: 1 } });
        return text(`pg.abort sent to ${member}`);
      },
    },
    {
      name: 'pg_steer',
      label: 'PiGroups steer',
      description: 'Send pg.steer with new instructions to a member (usually a direct child).',
      parameters: {
        type: 'object',
        properties: {
          member: { type: 'string', description: 'Member id to steer.' },
          text: { type: 'string', description: 'Instruction to inject.' },
        },
        required: ['member', 'text'],
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        const member = String(params.member);
        await pg.sendControl({
          to: member,
          id: randomUUID(),
          cmd: 'pg.steer',
          payload: { v: 1, text: String(params.text) },
        });
        return text(`pg.steer sent to ${member}`);
      },
    },
    {
      name: 'pg_say',
      label: 'PiGroups say',
      description: 'Send a message to a group (`g:<owner>`) or to a member id. Clears the owed reply for that conversation.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '`g:<owner>` or a member id.' },
          text: { type: 'string', description: 'Message body.' },
          mentions: { type: 'array', items: { type: 'string' }, description: 'Member ids, or ["all"].' },
        },
        required: ['to', 'text'],
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        const mentions = Array.isArray(params.mentions) ? params.mentions.map(String) : undefined;
        const sent = await requireLoop().say(String(params.to), String(params.text), mentions);
        return text(JSON.stringify(sent));
      },
    },
    {
      name: 'pg_read',
      label: 'PiGroups read',
      description: 'Read conversation history backwards, e.g. to backfill a gap or re-read the briefing.',
      parameters: {
        type: 'object',
        properties: {
          conv: { type: 'string', description: 'Conversation id (`g:<owner>` or `dm:<a>_<b>`).' },
          before: { type: 'number', description: 'Read messages before this seq.' },
          limit: { type: 'number', description: 'How many messages (max 200).' },
        },
        required: ['conv'],
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        const conv = String(params.conv);
        const before = typeof params.before === 'number' ? params.before : undefined;
        const limit = typeof params.limit === 'number' ? params.limit : undefined;
        const history = await pg.messages({ to: conv, before, limit });
        const lines = history.items.map((m) => `[${m.to}#${m.seq}] ${m.sender_name}: ${m.body}`);
        return text(lines.join('\n'));
      },
    },
    {
      name: 'pg_spawn',
      label: 'PiGroups spawn',
      description: 'Create a child member, send it the brief as a direct message, and start it in a new herdr pane.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Optional member name.' },
          brief: { type: 'string', description: 'Task brief, sent as the first direct message.' },
          cwd: { type: 'string', description: 'Working directory for the child.' },
        },
        required: ['brief'],
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        const spawned = await requireLoop().spawnMember({
          name: typeof params.name === 'string' ? params.name : undefined,
          brief: String(params.brief),
          cwd: typeof params.cwd === 'string' ? params.cwd : undefined,
        });
        return text(JSON.stringify(spawned));
      },
    },
    {
      name: 'pg_terminate',
      label: 'PiGroups terminate',
      description: 'Delete a child subtree (`DELETE /v1/members/{id}`); the platform cascades.',
      parameters: {
        type: 'object',
        properties: { member: { type: 'string', description: 'Member id to delete.' } },
        required: ['member'],
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        const result = await requireLoop().terminate(String(params.member));
        // The delete is committed either way. `pane_close_failed` is the cleanup that
        // did not happen yet (herdr down, a timeout); `pane_close_forced` names panes
        // that were closed while their agent was still running. Reporting both in the
        // same answer keeps the tool honest without pretending the delete failed (§5.3).
        return text(JSON.stringify(result));
      },
    },
    {
      name: 'pg_whoami',
      label: 'PiGroups whoami',
      description: 'Platform coordinates plus this adapter’s own state (owed conversations and nudge counts).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        const who = await pg.whoami();
        const loop = getLoop();
        // `adapter_version` is this adapter; `who.server.version` is the platform. Both
        // are in the answer so a person can tell which pair a member is running (§5.3).
        return text(JSON.stringify({ adapter_version: ADAPTER_VERSION, who, adapter: loop?.state() ?? null }, null, 2));
      },
    },
  ];
}

function text(value: string): { content: { type: 'text'; text: string }[]; details?: unknown } {
  return { content: [{ type: 'text', text: value }] };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
