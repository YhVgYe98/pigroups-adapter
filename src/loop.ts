/**
 * The loop: pull → classify → inject → obligations → telemetry.
 *
 * This module must not import the pi package (设计说明 §1): it only knows
 * `PiSurface`. That is the entire reason this repo is testable.
 */

import { randomUUID } from 'node:crypto';

import { Journal } from './journal.ts';
import { ObligationTable, TelemetryTable } from './state.ts';
import type { AttentionEvent, AttentionState, AttentionTool } from './state.ts';
import { PgError, PgGone, PgPollBusy, PgUnavailable } from './pgclient.ts';
import type {
  PgClient,
  PollBatch,
  PollControlItem,
  PollGapItem,
  PollMessageItem,
  PollItem,
} from './pgclient.ts';
import type { Herdr } from './herdr.ts';
import type { DeliverKind, PiEvent, PiSurface } from './surface.ts';

export interface LoopConfig {
  url: string;
  token: string;
  adapterDir: string;
  pollLimit: number;
  pollWait: number;
  attentionToolMs: number;
  remindWindowMs: number;
  nudgeMax: number;
  spawnCmd: string;
}

export interface InspectResult {
  phase: 'idle' | 'thinking' | 'output' | 'tool_call' | 'unknown';
  busy_ms: number;
  owed: string[];
  children: number;
  tool?: { name: string; elapsed_ms: number; preview: string };
}

export interface ChildSnapshot {
  id: string;
  name: string;
  state: 'ok' | 'stalled' | 'slow_turn' | 'error' | 'idle_owed' | 'gone';
  since: number;
  tool?: { name: string; elapsed_ms: number; preview: string };
  count: number;
}

export interface LoopDeps {
  pg: PgClient;
  surface: PiSurface;
  herdr: Herdr;
  config: LoopConfig;
  now: () => number;
}

interface PendingDelivery {
  text: string;
  kind: DeliverKind;
  /** Journal entry this item belongs to, so the entry survives until delivery. */
  journalId?: string;
  /** Conversation this item makes me owe a reply in (§4.2). */
  conv?: string;
  seq?: number;
}

const TICK_MS = 5000;
/** At most this many items per `deliver` (§3.4). */
const DELIVER_BATCH = 10;
/** §9: after five `poll_in_progress` conflicts in a row, rest this long. */
const POLL_CONFLICT_LIMIT = 5;
const POLL_CONFLICT_REST_MS = 30_000;
/** §9: connection failures back off exponentially, capped here. */
const CONNECT_BACKOFF_MAX_MS = 30_000;
const CONNECT_FAILURE_LIMIT = 20;
/** §8: the exit report gives up after two seconds. */
const REPORT_TIMEOUT_MS = 2000;
const DEFAULT_INSPECT_TIMEOUT_MS = 10_000;
const SPAWN_READY_MS = 120_000;

type AttentionExtra = { tool?: AttentionTool; owed?: string[]; note?: string; busy_ms?: number };

export class AdapterLoop {
  private readonly pg: PgClient;
  private readonly surface: PiSurface;
  private readonly herdr: Herdr;
  private readonly config: LoopConfig;
  private readonly now: () => number;

  private readonly journal: Journal;
  private readonly obligations = new ObligationTable();
  private readonly telemetry: TelemetryTable;
  private readonly pending: PendingDelivery[] = [];
  private readonly queuedByJournal = new Map<string, number>();
  private readonly inspectWaiters = new Map<string, (result: InspectResult) => void>();
  /** Child-side edge-triggered attention state (§5.1): one at a time. */
  private attention: { state: AttentionState } | undefined;
  /** Sticky until a turn ends without a provider error. */
  private errorNote: string | undefined;
  /** Conversations whose nudge budget is spent and that were already reported blocked (§4.3). */
  private readonly blockedReported = new Set<string>();

  private chatter = 0;
  private selfId: string | undefined;
  private selfName = '';
  private parentId: string | null = null;
  private readyPromise: Promise<void> | undefined;
  private ready = false;

  private tool: { name: string; preview: string; startedAt: number } | undefined;
  private turnStartedAt: number | null = null;

  private started = false;
  private stopped = false;
  private inLoop = false;
  private runPromise: Promise<void> | undefined;
  private settleUnsub: (() => void) | undefined;
  /** The flush currently delivering, so concurrent callers collapse into it (§2.3). */
  private flushInFlight: Promise<void> | undefined;
  private readonly eventUnsub: () => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pollAbort: AbortController | undefined;
  private pollConflicts = 0;
  private connectionFailures = 0;

  constructor(deps: LoopDeps) {
    this.pg = deps.pg;
    this.surface = deps.surface;
    this.herdr = deps.herdr;
    this.config = deps.config;
    this.now = deps.now;
    this.journal = new Journal(deps.config.adapterDir);
    this.telemetry = new TelemetryTable({ windowMs: deps.config.remindWindowMs });
    this.eventUnsub = deps.surface.onEvent((event) => this.handleEvent(event));
    // The settle reaction lives here, not in `start()` (§2.3): nudges (§4.3) and
    // the reminder (§5.2) hang off it, so a caller that never starts the timers
    // must still see it.
    this.subscribeSettled();
  }

  /** Start the three tasks (poll / flush / tick). Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.subscribeSettled();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    this.runPromise = this.run();
  }

  /** Stop and wait for in-flight work to finish. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.settleUnsub?.();
    this.settleUnsub = undefined;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.eventUnsub();
    this.pollAbort?.abort();
    const run = this.runPromise;
    if (run && !this.inLoop) await run.catch(() => {});
  }

  /** One pull: journal, classify, dispatch, then deliver whatever is held. */
  async pollOnce(): Promise<void> {
    await this.ensureReady();
    await this.flush();

    this.pollAbort ??= new AbortController();
    const batch = await this.pg.poll({
      wait: this.config.pollWait,
      limit: this.config.pollLimit,
      signal: this.pollAbort.signal,
    });
    await this.ingest(batch);
  }

  /**
   * Deliver what is held, if the agent is idle. A busy agent never gets a delivery (§3.4).
   *
   * Single-flight (§2.3): the constructor's settle subscription calls this on every
   * settle, so a tool, a test and the timer can call it at the same time. A second
   * caller awaits the batch already in flight instead of splicing its own, which
   * would re-concatenate the taken batch and append the chatter count twice.
   */
  async flush(): Promise<void> {
    const inFlight = this.flushInFlight;
    if (inFlight) {
      await inFlight;
      return;
    }
    const run = this.deliverPending();
    this.flushInFlight = run;
    try {
      await run;
    } finally {
      if (this.flushInFlight === run) this.flushInFlight = undefined;
    }
  }

  private async deliverPending(): Promise<void> {
    if (this.surface.isBusy()) return;
    if (this.pending.length === 0) return;

    const batch = this.pending.splice(0, DELIVER_BATCH);
    let text = batch.map((item) => item.text).join('\n');
    if (this.chatter > 0) text += `\n[另有 ${this.chatter} 条无关消息]`;
    const kind = batch.some((item) => item.kind === 'control') ? 'control' : batch[0].kind;

    try {
      await this.surface.deliver(text, kind);
    } catch {
      // Keep the journal entry and retry on the next settle (§9).
      this.pending.unshift(...batch);
      return;
    }

    this.chatter = 0;
    for (const item of batch) {
      if (item.conv !== undefined) {
        this.obligations.mark(item.conv, item.seq ?? 0, this.now());
        this.blockedReported.delete(item.conv);
      }
      if (item.journalId !== undefined) await this.releaseJournal(item.journalId);
    }
  }

  /**
   * One timer scan: owed replies, telemetry window, stalled detection (§3, §5).
   * Decisions only; `flush()` is what delivers, so a test can advance the fake
   * clock, call `tick()` and then `flush()` without sleeping.
   */
  tick(): void {
    if (this.stopped) return;
    const now = this.now();
    this.evaluateAttention(now);
    this.queueReminder(now);
  }

  /** The only send path: keeps the owed table honest (§2.3). */
  async say(to: string, text: string, mentions?: string[]): Promise<{ conv: string; seq: number }> {
    const sent = await this.pg.sendMessage({ to, body: text, mentions });
    this.obligations.clear(sent.to);
    this.blockedReported.delete(sent.to);
    this.evaluateAttention(this.now());
    return { conv: sent.to, seq: sent.seq };
  }

  async spawnMember(opts: { name?: string; brief: string; cwd?: string }): Promise<{ id: string; name: string }> {
    const requestId = randomUUID();
    const created = await this.pg.createMember({ name: opts.name, request_id: requestId });
    const id = created.member.id;
    const name = created.member.name;
    // A replayed create returns no token (platform §12); reissue for the direct child.
    const token = created.token ?? (await this.pg.reissueToken(id)).token;

    await this.say(id, opts.brief);

    const env: Record<string, string> = {
      PIGROUPS_URL: this.config.url,
      PIGROUPS_TOKEN: token,
      PIGROUPS_ADAPTER_DIR: this.config.adapterDir,
      PIGROUPS_SPAWN_CMD: this.config.spawnCmd,
    };
    const { pane } = await this.herdr.spawn({ label: name, env, cwd: opts.cwd });
    await this.herdr.waitReady(pane, SPAWN_READY_MS);
    return { id, name };
  }

  /** Ask a peer for `pg.inspect_result`; on timeout answer `unknown` rather than inventing (§9). */
  async inspect(peer: string, timeoutMs = DEFAULT_INSPECT_TIMEOUT_MS): Promise<InspectResult> {
    const request = randomUUID();
    const reply = new Promise<InspectResult>((resolve) => this.inspectWaiters.set(request, resolve));
    try {
      await this.pg.sendControl({
        to: peer,
        id: randomUUID(),
        cmd: 'pg.inspect',
        payload: { v: 1, request },
      });
      const timeout = sleep(timeoutMs).then(() => unknownInspect());
      return await Promise.race([reply, timeout]);
    } finally {
      this.inspectWaiters.delete(request);
    }
  }

  children(): ChildSnapshot[] {
    return this.telemetry.snapshot().map((entry) => ({
      id: entry.child,
      name: entry.name,
      state: entry.state === 'recovered' ? 'ok' : entry.state,
      since: entry.stateSince,
      tool: entry.tool,
      count: entry.count,
    }));
  }

  state(): { owed: string[]; nudges: Record<string, number> } {
    const nudges: Record<string, number> = {};
    for (const entry of this.obligations.entries()) nudges[entry.conv] = entry.nudges;
    return { owed: this.obligations.entries().map((entry) => entry.conv), nudges };
  }

  /** `pg_terminate`: delete the subtree and surface it in telemetry on the immediate channel (§5.2). */
  async terminate(member: string): Promise<string[]> {
    const known = this.telemetry.snapshot().find((entry) => entry.child === member);
    const { terminated } = await this.pg.deleteMember(member);
    const now = this.now();
    for (const id of terminated) {
      this.telemetry.apply(
        { child: id, name: id === member && known ? known.name : id, state: 'gone', since: now },
        now,
      );
    }
    return terminated;
  }

  // ---- startup -----------------------------------------------------------

  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    this.readyPromise ??= this.init().catch((err: unknown) => {
      this.readyPromise = undefined;
      throw err;
    });
    await this.readyPromise;
  }

  /** §8 startup: identity, briefing, owed reconciliation, journal replay. */
  private async init(): Promise<void> {
    const who = await this.pg.whoami();
    this.selfId = who.member.id;
    this.selfName = who.member.name;
    this.parentId = who.member.parent_id;
    await this.injectBrief();
    await this.reconcileObligations();
    await this.replayJournal();
    this.ready = true;
  }

  /** §8.3: the parent's last DM is the briefing, injected once. */
  private async injectBrief(): Promise<void> {
    const parent = this.parentId;
    const self = this.selfId;
    if (!parent || !self) return;
    const conv = dmConv(self, parent);
    const history = await this.pg.messages({ to: conv, limit: 1 });
    const brief = history.items[0];
    if (!brief || brief.sender_id !== parent) return;
    this.pending.push({
      text: `[${conv}#${brief.seq}] ${brief.sender_name}: ${brief.body}`,
      kind: 'message',
      conv,
      seq: brief.seq,
    });
  }

  /** §4.2: recompute the owed table from history, so a restart needs no local state. */
  private async reconcileObligations(): Promise<void> {
    const self = this.selfId;
    if (!self) return;
    const { items } = await this.pg.conversations();
    const now = this.now();
    for (const conv of items) {
      const last = await this.pg.messages({ to: conv.to, limit: 1 });
      const message = last.items[0];
      if (!message) continue;
      const addressed =
        message.mentions.includes(self) || (this.parentId !== null && message.sender_id === this.parentId);
      if (message.sender_id !== self && addressed) this.obligations.mark(conv.to, message.seq, now);
      else this.obligations.clear(conv.to);
    }
  }

  /** §3.1: replay batches that were journalled but never delivered. */
  private async replayJournal(): Promise<void> {
    for (const entry of await this.journal.pending()) {
      for (const item of entry.batch.items) await this.dispatch(item);
      await this.flush();
      await this.commitIfDrained(entry.id);
    }
  }

  // ---- one polled batch --------------------------------------------------

  private async ingest(batch: PollBatch): Promise<void> {
    const journalId = await this.journal.append({ taken_at: this.now(), items: batch.items });
    for (const item of batch.items) await this.dispatch(item, journalId);
    await this.flush();
    await this.commitIfDrained(journalId);
  }

  private async dispatch(item: PollItem, journalId?: string): Promise<void> {
    if (this.stopped) return;
    if (item.kind === 'control') await this.handleControl(item, journalId);
    else if (item.kind === 'message') this.classifyMessage(item, journalId);
    else this.classifyGap(item, journalId);
  }

  private classifyMessage(item: PollMessageItem, journalId?: string): void {
    if (item.mentions_me || item.from_parent || item.to.startsWith('dm:')) {
      this.enqueue(
        {
          text: `[${item.to}#${item.seq}] ${item.from_name}: ${item.preview}`,
          kind: 'message',
          journalId,
          conv: item.to,
          seq: item.seq,
        },
      );
      return;
    }
    this.chatter += 1;
  }

  private classifyGap(item: PollGapItem, journalId?: string): void {
    if (item.mentioned > 0) {
      this.enqueue({
        text: `[${item.to} 跳过了 ${item.count} 条，其中 ${item.mentioned} 条点了你的名；用 pg_read(to, before=${item.before}, limit=20) 回补]`,
        kind: 'message',
        journalId,
        conv: item.to,
        seq: item.before,
      });
      return;
    }
    this.chatter += item.count;
  }

  private async handleControl(item: PollControlItem, journalId?: string): Promise<void> {
    const payload = (item.payload ?? {}) as Record<string, unknown>;

    switch (item.cmd) {
      case 'sys.terminated':
        // Only the platform speaks for `sys` (platform §7.2).
        if (item.from_id !== 'sys') break;
        await this.discardAndShutdown(payload);
        return;

      case 'pg.abort':
        if (!this.fromHigherUp(item)) {
          this.logIgnored(item);
          return;
        }
        // No prompt is injected after an interrupt: the cut transcript is the hint (§5.1, §3.2).
        await this.surface.abort();
        return;

      case 'pg.steer': {
        if (!this.fromHigherUp(item)) {
          this.logIgnored(item);
          return;
        }
        if (this.surface.isBusy()) await this.surface.abort();
        const text = typeof payload.text === 'string' ? payload.text : '';
        this.enqueue({ text, kind: 'control', journalId });
        await this.flush();
        return;
      }

      case 'pg.inspect':
        await this.replyInspect(item, payload);
        return;

      case 'pg.inspect_result':
        this.settleInspect(payload);
        return;

      case 'pg.attention':
        this.applyAttention(payload);
        return;

      default:
        // Unknown commands are injected verbatim as controls (§3.2): the adapter
        // does not know the content, so it must not drop it.
        this.enqueue({
          text: `[control ${item.from_id}] ${item.cmd} ${JSON.stringify(payload)}`,
          kind: 'control',
          journalId,
        });
        await this.flush();
        return;
    }

    // A `sys.` command that did not come from `sys` is just an ordinary control.
    this.enqueue({
      text: `[control ${item.from_id}] ${item.cmd} ${JSON.stringify(payload)}`,
      kind: 'control',
      journalId,
    });
    await this.flush();
  }

  private async discardAndShutdown(payload: Record<string, unknown>): Promise<void> {
    await this.journal.discard();
    this.pending.length = 0;
    this.queuedByJournal.clear();
    await this.stop();
    const reason = typeof payload.reason === 'string' ? payload.reason : 'terminated';
    this.surface.shutdown(reason);
  }

  private fromHigherUp(item: PollControlItem): boolean {
    if (this.parentId !== null && item.from_id === this.parentId) return true;
    // Humans are the only other authority (§5.3); their ids are `h_…` (platform §3.1).
    return item.from_id.startsWith('h_');
  }

  private logIgnored(item: PollControlItem): void {
    console.warn(
      `[pigroups] ignored ${item.cmd} from ${item.from_id}: only the direct parent or a human may control this member`,
    );
  }

  private async replyInspect(item: PollControlItem, payload: Record<string, unknown>): Promise<void> {
    const request = typeof payload.request === 'string' ? payload.request : item.id;
    const result = this.inspectSelf();
    await this.pg.sendControl({
      to: item.from_id,
      id: randomUUID(),
      cmd: 'pg.inspect_result',
      payload: { v: 1, request, ...result },
      reply_to: item.id,
    });
  }

  private inspectSelf(): InspectResult {
    const now = this.now();
    return {
      phase: this.tool ? 'tool_call' : this.surface.isBusy() ? 'thinking' : 'idle',
      busy_ms: this.turnStartedAt === null ? 0 : now - this.turnStartedAt,
      owed: this.obligations.entries().map((entry) => entry.conv),
      children: this.telemetry.snapshot().length,
      tool: this.tool
        ? { name: this.tool.name, elapsed_ms: now - this.tool.startedAt, preview: this.tool.preview }
        : undefined,
    };
  }

  private settleInspect(payload: Record<string, unknown>): void {
    const request = typeof payload.request === 'string' ? payload.request : '';
    const resolve = this.inspectWaiters.get(request);
    if (!resolve) return;
    this.inspectWaiters.delete(request);
    resolve({
      phase: phaseOf(payload.phase),
      busy_ms: typeof payload.busy_ms === 'number' ? payload.busy_ms : 0,
      owed: Array.isArray(payload.owed) ? payload.owed.filter((c): c is string => typeof c === 'string') : [],
      children: typeof payload.children === 'number' ? payload.children : 0,
      tool: isAttentionTool(payload.tool) ? payload.tool : undefined,
    });
  }

  private applyAttention(payload: Record<string, unknown>): void {
    const child = typeof payload.child === 'string' ? payload.child : '';
    const state = attentionStateOf(payload.state);
    if (!child || !state) return;
    const event: AttentionEvent = {
      child,
      name: typeof payload.name === 'string' ? payload.name : child,
      state,
      since: typeof payload.since === 'number' ? payload.since : this.now(),
      of: attentionStateOf(payload.of),
      tool: isAttentionTool(payload.tool) ? payload.tool : undefined,
      owed: Array.isArray(payload.owed) ? payload.owed.filter((c): c is string => typeof c === 'string') : undefined,
      note: typeof payload.note === 'string' ? payload.note : undefined,
    };
    this.telemetry.apply(event, this.now());
  }

  // ---- delivery bookkeeping ---------------------------------------------

  private enqueue(item: PendingDelivery): void {
    this.pending.push(item);
    if (item.journalId !== undefined) {
      this.queuedByJournal.set(item.journalId, (this.queuedByJournal.get(item.journalId) ?? 0) + 1);
    }
  }

  private async releaseJournal(journalId: string): Promise<void> {
    const left = (this.queuedByJournal.get(journalId) ?? 0) - 1;
    if (left > 0) {
      this.queuedByJournal.set(journalId, left);
      return;
    }
    this.queuedByJournal.delete(journalId);
    await this.journal.commit(journalId);
  }

  private async commitIfDrained(journalId: string): Promise<void> {
    if ((this.queuedByJournal.get(journalId) ?? 0) === 0) {
      this.queuedByJournal.delete(journalId);
      await this.journal.commit(journalId);
    }
  }

  // ---- settle: delivery, nudges, telemetry (§4.3, §5.2) ------------------

  /** Subscribe once: a second `start()` must not react twice to one settle (§2.3). */
  private subscribeSettled(): void {
    if (this.settleUnsub !== undefined) return;
    this.settleUnsub = this.surface.onSettled(() => {
      void this.onSettled();
    });
  }

  private async onSettled(): Promise<void> {
    if (this.stopped) return;
    await this.flush();
    await this.nudgeOwed();
    this.queueReminder(this.now());
    await this.flush();
  }

  /**
   * §4.3: one `deliver(…, 'nudge')` per owed conversation per settle, straight from
   * the settle — not folded into the injection batch, whose kind and batching
   * (§3.4) belong to polled messages. The budget is per conversation and the
   * adapter reports `blocked` itself when it runs out, without the model.
   */
  private async nudgeOwed(): Promise<void> {
    const owed = this.obligations.entries();
    if (owed.length === 0) return;

    for (const entry of owed) {
      if (entry.nudges >= this.config.nudgeMax) {
        if (!this.blockedReported.has(entry.conv)) {
          this.blockedReported.add(entry.conv);
          await this.reportBlocked(`no output after ${entry.nudges} nudges (${entry.conv})`);
        }
        continue;
      }
      this.obligations.recordNudge(entry.conv);
      try {
        await this.surface.deliver(
          `你在 ${entry.conv} 还有未回复的消息 (#${entry.lastSeq})。回复，或说明为什么不需要回。`,
          'nudge',
        );
      } catch {
        // The obligation stays; the next settle nudges again (§9).
        console.warn(`[pigroups] nudge for ${entry.conv} failed; retrying on the next settle`);
      }
    }
  }

  /** The window expires into one held reminder, never into an interrupting delivery (§5.2). */
  private queueReminder(now: number): void {
    if (this.surface.isBusy()) return;
    const decision = this.telemetry.due(now);
    if (decision.kind !== 'remind') return;
    this.pending.push({ text: decision.text, kind: 'nudge' });
  }

  private async reportBlocked(text: string): Promise<void> {
    const parent = this.parentId;
    if (!parent) return;
    try {
      await withTimeout(
        this.pg.sendControl({
          to: parent,
          id: randomUUID(),
          cmd: 'pg.report',
          payload: { v: 1, status: 'blocked', text },
        }),
        REPORT_TIMEOUT_MS,
      );
    } catch {
      // Best effort: a parent that cannot be reached must not stop the loop.
    }
  }

  // ---- child-side telemetry: edge-triggered four states (§5.1) -----------

  private handleEvent(event: PiEvent): void {
    if (this.stopped) return;
    const now = this.now();
    switch (event.type) {
      case 'turn_start':
        this.turnStartedAt = now;
        return;
      case 'turn_end':
        this.turnStartedAt = null;
        this.tool = undefined;
        // A provider error sticks until a later turn ends cleanly.
        this.errorNote = event.error ? event.error.message : undefined;
        this.evaluateAttention(now);
        return;
      case 'tool_start':
        this.tool = { name: event.name, preview: event.argsPreview, startedAt: now };
        return;
      case 'tool_end':
        if (this.tool?.name === event.name) this.tool = undefined;
        this.evaluateAttention(now);
        return;
    }
  }

  /**
   * The parent keeps one state per child (§5.2), so the child reports one state
   * at a time. Precedence: a stalled tool is the concrete fact, then a provider
   * error, then a long turn, then owed replies while idle.
   */
  private desiredAttention(now: number): { state: AttentionState; extra: AttentionExtra } | undefined {
    const tool = this.tool;
    if (tool) {
      const elapsed = now - tool.startedAt;
      if (elapsed > this.config.attentionToolMs) {
        return {
          state: 'stalled',
          extra: { tool: { name: tool.name, elapsed_ms: elapsed, preview: tool.preview } },
        };
      }
    }
    if (this.errorNote !== undefined) return { state: 'error', extra: { note: this.errorNote } };
    if (this.turnStartedAt !== null) {
      const busy = now - this.turnStartedAt;
      if (busy > 2 * this.config.attentionToolMs) return { state: 'slow_turn', extra: { busy_ms: busy } };
    }
    if (!this.surface.isBusy()) {
      const owed = this.obligations.owedLongerThan(this.config.attentionToolMs, now);
      if (owed.length > 0) return { state: 'idle_owed', extra: { owed: owed.map((entry) => entry.conv) } };
    }
    return undefined;
  }

  private evaluateAttention(now: number): void {
    const desired = this.desiredAttention(now);
    const current = this.attention;
    if (current && current.state !== desired?.state) {
      this.attention = undefined;
      this.publishAttention({ state: 'recovered', of: current.state, since: now });
    }
    if (desired && this.attention?.state !== desired.state) {
      this.attention = { state: desired.state };
      this.publishAttention({ state: desired.state, since: now, ...desired.extra });
    }
  }

  private publishAttention(event: Record<string, unknown>): void {
    const parent = this.parentId;
    const self = this.selfId;
    if (!parent || !self) return;
    void this.pg
      .sendControl({
        to: parent,
        id: randomUUID(),
        cmd: 'pg.attention',
        payload: { v: 1, child: self, name: this.selfName, ...event },
      })
      .catch(() => {
        // Telemetry is best effort; the loop must not stop on a failed report.
      });
  }

  // ---- tasks -------------------------------------------------------------

  private async run(): Promise<void> {
    this.inLoop = true;
    try {
      while (!this.stopped) {
        try {
          await this.pollOnce();
          this.pollConflicts = 0;
          this.connectionFailures = 0;
        } catch (err) {
          if (this.stopped || isAbort(err)) break;
          await this.handlePollError(err);
        }
      }
    } finally {
      this.inLoop = false;
    }
  }

  private async handlePollError(err: unknown): Promise<void> {
    if (err instanceof PgGone) {
      await this.stop();
      this.surface.shutdown('member_gone');
      return;
    }

    if (err instanceof PgPollBusy) {
      this.pollConflicts += 1;
      const rest = this.pollConflicts >= POLL_CONFLICT_LIMIT;
      const delayMs = rest ? POLL_CONFLICT_REST_MS : (err.retryAfterMs ?? 1000);
      if (rest) this.pollConflicts = 0;
      await sleep(delayMs);
      return;
    }

    if (err instanceof PgUnavailable) {
      this.connectionFailures += 1;
      if (this.connectionFailures >= CONNECT_FAILURE_LIMIT) {
        await this.reportBlocked(`platform unreachable after ${this.connectionFailures} attempts`);
        await this.stop();
        return;
      }
      await sleep(Math.min(CONNECT_BACKOFF_MAX_MS, 1000 * 2 ** (this.connectionFailures - 1)));
      return;
    }

    if (err instanceof PgError && err.status === 401) {
      this.stop();
      this.pending.push({ text: 'PIGROUPS token 失效：请更新 token 并重启本 session。', kind: 'message' });
      await this.flush();
      return;
    }

    console.warn(`[pigroups] poll failed: ${(err as Error)?.message ?? String(err)}`);
    await sleep(1000);
  }
}

function dmConv(a: string, b: string): string {
  const [first, second] = a < b ? [a, b] : [b, a];
  return `dm:${first}_${second}`;
}

function unknownInspect(): InspectResult {
  return { phase: 'unknown', busy_ms: 0, owed: [], children: 0 };
}

function phaseOf(value: unknown): InspectResult['phase'] {
  return value === 'idle' || value === 'thinking' || value === 'output' || value === 'tool_call'
    ? value
    : 'unknown';
}

function attentionStateOf(value: unknown): AttentionState | undefined {
  return value === 'stalled' ||
    value === 'slow_turn' ||
    value === 'error' ||
    value === 'idle_owed' ||
    value === 'recovered' ||
    value === 'gone'
    ? value
    : undefined;
}

function isAttentionTool(value: unknown): value is AttentionTool {
  if (typeof value !== 'object' || value === null) return false;
  const tool = value as Record<string, unknown>;
  return (
    typeof tool.name === 'string' &&
    typeof tool.elapsed_ms === 'number' &&
    typeof tool.preview === 'string'
  );
}

function isAbort(err: unknown): boolean {
  return (err as Error)?.name === 'AbortError';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
