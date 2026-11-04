/**
 * The loop: pull → classify → inject → obligations → telemetry.
 *
 * This module must not import the pi package (设计说明 §1): it only knows
 * `PiSurface`. That is the entire reason this repo is testable.
 */

import { randomUUID } from 'node:crypto';

import { Journal } from './journal.ts';
import { OwedLedger } from './owed.ts';
import { NudgeBudget, TelemetryTable } from './state.ts';
import { Watermarks } from './watermark.ts';
import type { AttentionEvent, AttentionState, AttentionTool, LastRound, LastTool } from './state.ts';
import type { OwedFlag } from './owed.ts';
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
import { ABORT_IDLE_TIMEOUT_MS } from './surface.ts';
import { platformCompatibilityWarning } from './version.ts';
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
  /** Tumbling delivery window (概念稿 §8.1): the first queued item opens it. */
  deliveryWindowMs: number;
  /** How long a spawned child gets to authenticate before the parent is told it never did. */
  spawnReadyMs: number;
}

export interface InspectResult {
  phase: 'idle' | 'thinking' | 'output' | 'tool_call' | 'unknown';
  busy_ms: number;
  owed: string[];
  children: number;
  tool?: { name: string; elapsed_ms: number; preview: string };
  /** What the member's last round did (概念稿 §8.5). */
  last?: LastRound;
}

export interface ChildSnapshot {
  id: string;
  name: string;
  state: 'ok' | 'stalled' | 'slow_turn' | 'error' | 'idle_owed' | 'gone';
  since: number;
  tool?: { name: string; elapsed_ms: number; preview: string };
  count: number;
  /** What that child's last round did (概念稿 §8.5). */
  last?: LastRound;
}

/** One row of the live roster behind `pg_members` (概念稿 §7.1). */
export interface RosterMember {
  id: string;
  name: string;
  parent_id: string | null;
  parent_name: string | null;
  relation: 'self' | 'parent' | 'child' | 'sibling' | 'peer';
  child_count: number;
  /** The last time that member authenticated — not a liveness signal. */
  last_seen_at: number | null;
}

export interface MembersResult {
  /** This member's own id; it also appears in `members` with `relation: 'self'`. */
  self: string;
  /** Every living member before the filter, so `matched: 0` reads as "bad query", not "nobody exists". */
  total: number;
  /** Rows after the name filter. */
  matched: number;
  members: RosterMember[];
}

export interface ScheduleResult {
  /** When the wake will fire, on the injected clock. */
  due_at: number;
  /** Wakes still waiting, including this one. */
  pending: number;
}

/** What `pg_ack` did: the flags it cleared, and the debts that are still there (§4.3). */
export interface AckResult {
  cleared: Array<{ conv: string; seq: number }>;
  remaining: Array<{ conv: string; seq: number }>;
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
  /**
   * This item does not wait for a window (概念稿 §8.4: the start-up brief is injected
   * at startup, not 60 s later). It still rides the same queue, so a batch that is
   * already held goes out with it in one call.
   */
  windowless?: true;
  /** Journal entry this item belongs to, so the entry survives until delivery. */
  journalId?: string;
  /** Conversation this item makes me owe a reply in (§4.2). */
  conv?: string;
  seq?: number;
  /**
   * `seq` is a backfill anchor, not a shown message (§3.3 gap line): it is checked
   * against the watermark when enqueued, but delivery must not advance it (§3.4).
   */
  anchor?: true;
  /**
   * This delivery must not set an owed flag (§4.2: "启动简报不置"). The task book a member
   * is spawned with is a one-to-one message from its parent, so the normal rule would give
   * it a debt for the work it was just handed. Set only for a fresh spawn (`injectBrief`).
   */
  noOwed?: boolean;
}

/**
 * What one `flush` did. `flush()` answers only "did something go out", which is what
 * a caller needs; `tick()` and the abort path also care whether the window is still
 * open (`waiting`) or an abort is holding delivery (`aborting`).
 */
type FlushOutcome = 'delivered' | 'waiting' | 'aborting' | 'stopped' | 'empty' | 'failed';

const TICK_MS = 5000;
/**
 * At most this many items per `deliver` (§3.5). A size cap, never a trigger: a
 * window that holds more closes, sends this many, and reopens a window for the rest
 * (概念稿 §8.1: count may be a safety valve, never the thing that starts a delivery).
 */
const DELIVER_BATCH = 10;
/**
 * How many delivered-but-unacknowledged batches one turn may hold (§8.3 ②). At most
 * one batch joins per delivery window, so eight entries cover a turn that spans eight
 * windows — eight minutes at the default 60 s window — with at most 80 items in memory.
 * A turn older than that is already outliving anything this adapter has measured, and
 * unbounded growth is the only alternative. The oldest entry goes first, so the list
 * stays a recovery for recent windows rather than a second journal; a drop is logged,
 * because it is a lost copy, not a silent trim.
 */
const UNACKNOWLEDGED_BATCH_LIMIT = 8;
/** §13.5: the last assistant text travels truncated; the tool preview is already 200. */
const LAST_TEXT_CHARS = 500;
/** §7.5 / §13.2: the bounds of `pg_schedule`. */
const SCHEDULE_MIN_SECONDS = 5;
const SCHEDULE_MAX_SECONDS = 86_400;
const SCHEDULE_MAX_PENDING = 8;
/** §4.3: this many confirmations in a row, with no reply between them, are reported once. */
const SILENT_ACK_LIMIT = 3;
/** §9: after five `poll_in_progress` conflicts in a row, rest this long. */
const POLL_CONFLICT_LIMIT = 5;
const POLL_CONFLICT_REST_MS = 30_000;
/** §9: connection failures back off exponentially, capped here. */
const CONNECT_BACKOFF_MAX_MS = 30_000;
const CONNECT_FAILURE_LIMIT = 20;
/** §8: the exit report gives up after two seconds. */
const REPORT_TIMEOUT_MS = 2000;
/**
 * §2.3: how long `stop()` waits for in-flight work. Deliberate, not defensive: a
 * surface that never answers a held `deliver` is the surface's problem, and hanging
 * the exit is worse — exit is the last step of the delete path. Hitting this bound is
 * a give-up, not an error: the batch is still journalled (an entry is committed only
 * after `deliver` returns), so the next start replays it (§3.1).
 */
const STOP_TIMEOUT_MS = 3000;

/** A roster read is a settle/startup cost, not a poll-time one (§4.1). */
const ROSTER_TTL_MS = 30_000;
/** A slow roster must delay startup, or a settle reaction, no further than this. */
const ROSTER_TIMEOUT_MS = 2000;
/** A failed roster read is not retried on every settle; the platform may be down. */
const ROSTER_RETRY_BACKOFF_MS = 5000;
/**
 * A pane check is the same kind of cost (§5.3): a live child costs at most one
 * `GET /v1/members/{id}` per TTL, and a dead one is closed within that TTL.
 */
const PANE_CHECK_TTL_MS = 30_000;

/** The state of one `pg_schedule` wake: one shot, in memory only (§7.5). */
interface ScheduledWake {
  dueAt: number;
  note: string;
}

/** One roster read. `at` is what makes a snapshot safe to prune against (§4.1). */
interface RosterSnapshot {
  at: number;
  ids: Set<string>;
  /** The ids whose `parent_id` was this member in that same read (§5.1). */
  directChildren: Set<string>;
}

/** What `terminate()` did: the delete, and what happened to the panes it took with it (§5.3). */
export interface TerminateResult {
  /** The platform's cascade answer (`DELETE /v1/members/{id}`). */
  terminated: string[];
  /** Panes whose close failed for a reason a retry may fix; the member is gone either way. */
  pane_close_failed: Array<{ member: string; pane: string; error: string }>;
  /** Panes that had to be closed while their agent was still running at the bound. */
  pane_close_forced: Array<{ member: string; pane: string }>;
}

/** One pane close: nothing to report, a retryable failure, or a close forced past a live agent. */
interface PaneCloseOutcome {
  failure?: { member: string; pane: string; error: string };
  forced?: { member: string; pane: string };
}

/** Hand one macrotask back to the event loop, so timers and sockets can run. */
function yieldOnce(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
const DEFAULT_INSPECT_TIMEOUT_MS = 10_000;
/** Default for `spawnReadyMs`; tests override it through the config. */
const SPAWN_READY_MS = 120_000;
/** How often D1 is checked while a child starts. Its first poll lands in well under a second. */
const READY_POLL_MS = 150;
/** Only used to word the failure: "process never appeared" vs "it started and cannot reach us". */
const READY_DIAGNOSTIC_MS = 3000;

type AttentionExtra = { tool?: AttentionTool; owed?: string[]; note?: string; busy_ms?: number };

export class AdapterLoop {
  private readonly pg: PgClient;
  private readonly surface: PiSurface;
  private readonly herdr: Herdr;
  private readonly config: LoopConfig;
  private readonly now: () => number;

  private readonly journal: Journal;
  private readonly watermark: Watermarks;
  /**
   * The owed-reply flags (§4.2). Persisted, unlike the old history-derived table: a debt
   * can only be trusted across a restart if it is a fact on disk, not an inference.
   */
  private readonly owed: OwedLedger;
  /** The nudge budget and blocked episodes (§4.3). In memory: an episode is this process's. */
  private readonly nudges = new NudgeBudget();
  private readonly telemetry: TelemetryTable;
  private readonly pending: PendingDelivery[] = [];
  private readonly queuedByJournal = new Map<string, number>();
  private readonly inspectWaiters = new Map<string, (result: InspectResult) => void>();
  /**
   * The tumbling window (概念稿 §8.1): set when the first queued item arrives, cleared
   * when its batch is delivered. There is no second timer — `tick()` reads the clock.
   */
  private windowStart: number | null = null;
  /** A nudge is due but must wait for a window with nothing else in it (§8.4). */
  private nudgeDue = false;
  /**
   * The last nudge text this session delivered (§4.3). A nudge identical to this one is
   * skipped: the same conversation at the same seq is already in the context.
   */
  private lastNudgeText: string | undefined;
  /**
   * The next windowed item goes out at the next opportunity, without waiting for a
   * window. Armed by an abort (概念稿 §8.3 ①): the window exists to avoid interrupting
   * work, and the abort just stopped the work, so a message that follows — the "abort,
   * then say" pair the concept calls immediately effective — must not wait 60 s.
   */
  private windowImmediate = false;
  /**
   * Every batch pi accepted and the turn has not acknowledged yet, in delivery order.
   * pi can drop a still-queued steer when an abort lands (§8.3); the copies are in
   * memory only, because losing them on a crash costs at most one re-delivery and the
   * injected text already carries `[conv#seq]` markers against duplicates. One entry
   * per delivery — not one slot — because two windows can steer into the same turn,
   * and an abort takes back both.
   */
  private readonly unacknowledged: PendingDelivery[][] = [];
  /** One-shot wakes, in memory only: a restart drops them (§7.5). */
  private schedules: ScheduledWake[] = [];
  /**
   * The pane each spawned child lives in. `terminate()` closes it after the platform
   * has marked the subtree gone: a pi process can exit on `sys.terminated` and still
   * leave its pane behind at a shell prompt (§5.3, 概念稿 §5.1).
   */
  private readonly panes = new Map<string, string>();
  /** Child-side edge-triggered attention state (§5.1): one at a time. */
  private attention: { state: AttentionState } | undefined;
  /** Sticky until a turn ends without a provider error. */
  private errorNote: string | undefined;
  /**
   * Conversations whose nudge budget is spent and that were already reported blocked (§4.3).
   * The episode stands until the member speaks: only `say()` clears an entry.
   */
  private readonly blockedReported = new Set<string>();
  /**
   * §4.3: consecutive confirmations per conversation since the last reply. A confirmation
   * is deliberately silent (no message, no new debt), so "acking instead of working" can
   * only be seen from this side; three in a row without a reply is reported once.
   */
  private readonly silentAcks = new Map<string, number>();
  /** The dedup marker for that report; only `say()` clears it, so one episode reports once. */
  private readonly silentAckReported = new Set<string>();

  private chatter = 0;
  /**
   * The briefing message (§8.3.3), read from history at startup. A new member's poll
   * queue still holds that same message (platform §10.6), so the poll hands it again
   * and one message would be injected twice. This is its identity — the in-process half
   * of §3.4; the persisted watermark (`Watermarks`) covers the restart.
   */
  private brief: { conv: string; seq: number } | undefined;
  private selfId: string | undefined;
  private selfName = '';
  private parentId: string | null = null;
  private readyPromise: Promise<void> | undefined;
  private ready = false;

  private tool: { name: string; preview: string; startedAt: number } | undefined;
  /** The args preview of every running tool, so `lastTool` can name what actually ran. */
  private readonly runningToolPreviews = new Map<string, string>();
  /** The last finished tool call, reported as part of the last-round block (§8.5). */
  private lastTool: LastTool | undefined;
  private turnStartedAt: number | null = null;

  private started = false;
  private stopped = false;
  /** §8: the compatibility warning is emitted once per process, even if startup retries. */
  private compatibilityChecked = false;
  private inLoop = false;
  private runPromise: Promise<void> | undefined;
  private settleUnsub: (() => void) | undefined;
  /** The flush currently delivering, so concurrent callers collapse into it (§2.3). */
  private flushInFlight: Promise<FlushOutcome> | undefined;
  /** Every `surface.deliver` the surface has not answered yet, so `stop()` can wait (§2.3). */
  private readonly deliveries = new Set<Promise<unknown>>();
  /**
   * Every settle reaction still running. `stop()` waits for them (§2.3): the reaction
   * awaits the platform before it delivers, so a `stop()` that only looked at
   * `deliveries` could return while a delivery was still about to start.
   */
  private readonly settles = new Set<Promise<unknown>>();
  /** The last good roster (§4.4), cached: an obligation check must not cost a request per settle. */
  private roster: RosterSnapshot | undefined;
  /** After a failed roster read, the next attempt waits until this instant. */
  private rosterRetryAt = 0;
  /**
   * When `isDirectChild()` last tried to refresh a stale roster. A miss costs at most one
   * request per `ROSTER_TTL_MS`, and a failed refresh does not retry inside that TTL either.
   */
  private childRosterCheckedAt = Number.NEGATIVE_INFINITY;
  /** When each mapped child's status was last confirmed with `GET /v1/members/{id}` (§5.3). */
  private readonly paneCheckedAt = new Map<string, number>();
  /**
   * Members this process already reported `gone` (§5.1). The telemetry row is deleted as soon
   * as the reminder is delivered (§5.2), so the row cannot be the dedup key: three paths can
   * learn the same disappearance (this adapter's delete, the member's own `exiting`, the 30 s
   * recheck), and a failed pane close keeps the recheck alive. Without this set each path
   * rebuilt the row and the parent got one urgent injection per path — the 6.5 hour replay
   * with a new trigger. Memory only: what survives a restart is Q7's problem, not this one.
   */
  private readonly goneReported = new Set<string>();
  /** A `pg.abort` is cutting the turn: no delivery may start one (§3.2). */
  private aborting = false;
  /** Ends an in-flight abort wait when `stop()` runs (§3.2). */
  private readonly stopGate = new AbortController();
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
    this.watermark = new Watermarks(deps.config.adapterDir);
    this.owed = new OwedLedger(deps.config.adapterDir);
    this.telemetry = new TelemetryTable({ windowMs: deps.config.remindWindowMs });
    this.eventUnsub = deps.surface.onEvent((event) => this.handleEvent(event));
    // The settle reaction lives here, not in `start()` (§2.3): nudges (§4.3) and
    // the reminder (§5.2) hang off it, so a caller that never starts the timers
    // must still see it.
    this.subscribeSettled();
  }

  /** Start the three tasks (poll / tick / settle reaction). Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.subscribeSettled();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    this.runPromise = this.run();
  }

  /**
   * Await the settle reactions in flight right now (§2.3). The same seam `stop()`
   * uses, exposed so a test can wait for the reaction instead of guessing a delay.
   */
  async settled(): Promise<void> {
    while (this.settles.size > 0) await Promise.all([...this.settles]);
  }

  /** Stop and wait for in-flight work to finish (§2.3). */
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
    // Nothing waits for a turn any more: a control item blocked on `abort()`
    // returns instead of holding the loop (§3.2).
    this.stopGate.abort();

    // §2.3: `stop()` waits for in-flight work, and a `deliver` the surface is still
    // holding *is* in-flight work — resolving before it settles would report a quiet
    // loop while the agent is still being handed a batch. Everything outstanding is
    // awaited together: the task loop, the single-flight flush that started the
    // delivery, and any delivery started outside it (the nudge, §4.3).
    const work: Promise<unknown>[] = [];
    const run = this.runPromise;
    if (run && !this.inLoop) work.push(run.catch(() => undefined));
    const flush = this.flushInFlight;
    if (flush) work.push(flush.catch(() => undefined));
    // A settle that is still inside `pruneUnanswerableDms()`/`reconcileMembers()` has
    // not started its delivery yet, so `deliveries` cannot see it. Wait for the whole
    // reaction: it re-checks `stopped` after each await and will not deliver now.
    for (const settle of this.settles) work.push(settle.catch(() => undefined));
    for (const delivery of this.deliveries) work.push(delivery.catch(() => undefined));
    if (work.length === 0) return;
    // Bounded at `STOP_TIMEOUT_MS` (§2.3). Giving up is not an error: the loops are
    // stopped, the delivery stays journalled, and the next start replays it (§3.1).
    await withTimeout(Promise.all(work), STOP_TIMEOUT_MS).catch(() => undefined);
  }

  /**
   * One pull: journal, classify, dispatch, then let the window decide. `flush()` here
   * only delivers a window that is already due; an item this poll just enqueued opens
   * (or joins) a window and waits for `tick()`.
   */
  async pollOnce(): Promise<void> {
    try {
      await this.ensureReady();
      // The poll loop keeps running while the member is idle, which makes it the one
      // path that can notice an ancestor's delete between settles (§5.3, §5.1 path 3).
      // Bounded by `PANE_CHECK_TTL_MS`, and it returns at once when neither a pane nor
      // a telemetry entry names a member.
      await this.reconcileMembers();
      await this.flush();

      this.pollAbort ??= new AbortController();
      const batch = await this.pg.poll({
        wait: this.config.pollWait,
        limit: this.config.pollLimit,
        signal: this.pollAbort.signal,
      });
      await this.ingest(batch);
    } catch (err) {
      // §9: a poll answered 410 `member_gone` is handled here, at the poll, not only
      // in the task loop — `pollOnce()` is the documented manual drive (§2.3), so a
      // caller driving it by hand must reach the same stop+shutdown instead of
      // getting a thrown error and a member that keeps living. The whole pull is
      // covered, so a member that is already gone when `whoami` runs ends the same
      // way. Every other answer stays with `handlePollError`, which owns pacing,
      // retrying and the 401 hand-off to a human.
      if (err instanceof PgGone) {
        await this.goneAndShutdown();
        return;
      }
      throw err;
    }
  }

  /**
   * Deliver the current window if it is due (概念稿 §8.1). A window that is still
   * open, or an abort that is cutting a turn, delivers nothing — but a window is no
   * longer held back by a busy agent: delivery is a pi `steer`.
   *
   * Returns whether this call actually delivered. `tick()` is what closes a window in
   * production; tests drive it by advancing the injected clock and calling `tick()`.
   *
   * Single-flight (§2.3): the timer, a tool and a test can call this at the same
   * time. A second caller awaits the batch already in flight instead of splicing its
   * own, which would re-concatenate the taken batch and append the chatter count twice.
   */
  async flush(): Promise<boolean> {
    return (await this.flushOutcome()) === 'delivered';
  }

  /**
   * The same single-flight call, keeping *why* nothing went out (see `FlushOutcome`).
   * `force` is the abort path (概念稿 §8.3 ①): once a turn has been cut, the reason the
   * window exists — don't interrupt running work — is gone, so what is pending goes out
   * at once instead of waiting for the timer.
   */
  private async flushOutcome(force = false): Promise<FlushOutcome> {
    const inFlight = this.flushInFlight;
    if (inFlight) {
      const outcome = await inFlight;
      // A forced call must not be answered by a window check that ran before the
      // abort landed; anything else (delivered, empty, failed) is already the answer.
      if (!force || outcome !== 'waiting') return outcome;
    }
    const tracked = this.deliverPending(force).finally(() => {
      if (this.flushInFlight === tracked) this.flushInFlight = undefined;
    });
    this.flushInFlight = tracked;
    return tracked;
  }

  /** True when the window has run its course (or something in it may not wait). */
  private windowDue(now: number): boolean {
    if (this.pending.length === 0 && !this.nudgeDue) return false;
    // The start-up brief does not wait for a window (§8.4), and neither does the first
    // batch after an abort (§8.3 ①), nor a batch already holding one: they go out
    // together, in one call.
    if (this.windowImmediate) return true;
    if (this.pending.some((item) => item.windowless === true)) return true;
    return this.windowStart !== null && now - this.windowStart >= this.config.deliveryWindowMs;
  }

  private async deliverPending(force = false): Promise<FlushOutcome> {
    // A stopped loop delivers nothing: `stop()` is the last step of the delete path and of
    // process exit, and a manual `flush()` must not start a turn behind it.
    if (this.stopped) return 'stopped';
    // §3.2: an abort is cutting the turn. Delivering now would be the very turn the
    // abort then waits for; the abort path itself calls back with `force` once the
    // cut is over (概念稿 §8.3 ①).
    if (this.aborting) return 'aborting';
    if (this.pending.length === 0 && !this.nudgeDue) {
      this.windowStart = null;
      return 'empty';
    }
    const now = this.now();
    if (!force && !this.windowDue(now)) return 'waiting';

    // §8.4: real items win the window; the nudge is only delivered when there is
    // nothing else to put in front of the model, and otherwise waits for a quiet one.
    const batch = this.pending.slice(0, DELIVER_BATCH);
    let text: string;
    let kind: DeliverKind;
    let nudged: OwedFlag[] = [];
    if (batch.length > 0) {
      let joined = batch.map((item) => item.text).join('\n');
      if (this.chatter > 0) joined += `\n[and ${this.chatter} unrelated messages]`;
      text = joined;
      kind = batch.some((item) => item.kind === 'control') ? 'control' : batch[0].kind;
    } else {
      nudged = this.owableNudges();
      if (nudged.length === 0) {
        this.nudgeDue = false;
        this.windowStart = null;
        return 'empty';
      }
      text = nudgeText(nudged);
      kind = 'nudge';
      // §4.3: the same text as the last nudge this session is not delivered twice. The
      // one `(conv, #seq)` it names is already in the context above, so a repeat adds
      // nothing — it was 61 of the 62 verbatim duplicates measured on a real run. The
      // skip is logged, but it still spends one unit of budget per conversation: a
      // frozen debt must reach `no output after N nudges`, and `idle_owed` does not
      // carry the budget, so a skip that cost nothing would hide the loop from both
      // sides. `lastNudgeText` stays: the next due is still compared with what the
      // model actually saw.
      if (text === this.lastNudgeText) {
        console.warn(
          `[pigroups] skipped a repeated nudge, identical to the last one this session: ${text}`,
        );
        for (const entry of nudged) this.nudges.record(entry.conv);
        this.nudgeDue = false;
        this.windowStart = null;
        return 'empty';
      }
    }

    try {
      await this.trackDelivery(this.surface.deliver(text, kind));
    } catch {
      // Nothing was delivered: the batch and its journal entry stay queued, and the
      // window is left as it was so the next flush retries (§9).
      return 'failed';
    }

    if (batch.length === 0) {
      // §4.3: a delivered nudge counts against the budget and becomes the text a later
      // nudge is compared against. A skipped one was counted where it was skipped.
      this.lastNudgeText = text;
      for (const entry of nudged) {
        this.nudges.record(entry.conv);
        // §4.3 / Q11: the nudge named `#seq`, so that seq is now answerable by `pg_ack`
        // even when it never reached the injection watermark (a gap anchor, §3.4).
        this.owed.advance(entry.conv, entry.seq);
      }
      this.nudgeDue = false;
      this.windowStart = null;
      this.windowImmediate = false;
      return 'delivered';
    }

    const sent = new Set(batch);
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (sent.has(this.pending[i])) this.pending.splice(i, 1);
    }
    this.chatter = 0;
    // §8.3 ②: "pi accepted it" is not "the model saw it". Keep the batch in memory so
    // an aborted turn can put it back (`handleEvent` → `requeueUnacknowledged`).
    this.unacknowledged.push(batch);
    if (this.unacknowledged.length > UNACKNOWLEDGED_BATCH_LIMIT) {
      const dropped = this.unacknowledged.shift() ?? [];
      console.warn(
        `[pigroups] ${UNACKNOWLEDGED_BATCH_LIMIT} delivered batches are still unacknowledged ` +
          `(one turn spanning that many windows); dropping the oldest, ${dropped.length} item(s): ` +
          `an abort will not replay it`,
      );
    }
    // Three records are written per item, and the order between them decides which window
    // a crash can land in:
    //
    //   1. the owed flag (§4.2): "a message is in my context and I have not answered it";
    //   2. the injection watermark (§3.4): "this `(conv, seq)` has been shown";
    //   3. the journal entry (§3.1): the only copy of the item — dropped last, so a crash
    //      before it replays the batch.
    //
    // The debt goes first on purpose. A crash between the two writes is possible either way
    // (two files cannot be renamed atomically), so the question is which loss it may cause:
    // flag first → the watermark is behind, the journal replays, the model sees the message
    // twice and `set` keeps the earlier flag; watermark first → the replay is suppressed
    // ("already seen"), the entry is committed and the debt is gone for good. This file
    // chooses the duplicate: "错剪会丢一条真债" is the rule the prune path already follows,
    // and a re-shown `[conv#seq]` costs one turn while a lost flag is silence.
    for (const item of batch) {
      if (item.conv !== undefined) {
        // §4.2: a delivered message is what makes the conversation owed. The start-up
        // brief is the one delivery that must not create a debt ("启动简报不置"): it is a
        // one-to-one message from the parent, so the normal rule would make the member owe
        // a reply for the task book it was just handed. It still advances the high-water
        // seq — the brief's `#seq` was named in the context.
        if (item.seq !== undefined) {
          if (item.noOwed === true) this.owed.advance(item.conv, item.seq);
          else await this.owed.set(item.conv, item.seq, this.now());
        }
        // §3.4: the watermark moves only now, after `deliver` returned, so a delivery
        // that throws or a crash in between cannot make the message disappear. This is
        // an acknowledgement that pi accepted the message, not that a run started
        // (`sendMessage` is void and swallows start failures; see 设计说明 §3.4).
        // A gap is the exception: its `seq` is a backfill anchor, and when nothing was
        // retained the platform sets it to "newest skipped seq + 1" (platform §6.4) —
        // the seq the next real message will carry. Writing it would drop that message
        // as already-seen, and a gap never comes again.
        if (item.seq !== undefined && item.anchor !== true) await this.watermark.advance(item.conv, item.seq);
      }
      if (item.journalId !== undefined) await this.releaseJournal(item.journalId);
    }
    // A batch cap or a held-back nudge leaves something behind: open the next window
    // now, so the remainder waits a whole window rather than riding this close (§8.1).
    // Read the clock after the delivery: a slow `deliver` must not eat into it.
    this.windowStart = this.pending.length > 0 || this.nudgeDue ? this.now() : null;
    this.windowImmediate = false;
    return 'delivered';
  }

  /** Conversations the nudge may name: owed, and not past their budget. */
  private owableNudges(): OwedFlag[] {
    return this.owed.entries().filter((entry) => this.nudges.count(entry.conv) < this.config.nudgeMax);
  }

  /**
   * One timer scan: schedules, telemetry, stalled detection, and window expiry (§3, §5).
   * The window is checked here — the existing 5 s tick is the only clock delivery has
   * (概念稿 §8.1), so there is no second timer.
   */
  tick(): void {
    if (this.stopped) return;
    const now = this.now();
    this.fireDueSchedules(now);
    this.evaluateAttention(now);
    this.queueReminder(now);
    if (!this.windowDue(now)) return;
    void this.flush().catch((err: unknown) => {
      console.warn(`[pigroups] delivery failed: ${(err as Error)?.message ?? String(err)}`);
    });
  }

  /** The only send path: keeps the owed ledger honest (§2.3, §4.2). */
  async say(to: string, text: string, mentions?: string[]): Promise<{ conv: string; seq: number }> {
    let sent: { to: string; seq: number };
    try {
      sent = await this.pg.sendMessage({ to, body: text, mentions });
    } catch (err) {
      // A peer that just died answers 410, and the debt it created is unpayable from
      // that moment. Forgetting it here is the difference between "cannot reply yet"
      // and "is being told forever to reply to nobody".
      if (err instanceof PgGone && !to.startsWith('g:')) await this.forgetDm(to);
      throw err;
    }
    // §4.2: replying clears the flag. This is also the one event that ends a blocked
    // episode (§4.3) and the run of silent confirmations that reports it, because the
    // member has spoken: the next debt starts with a clean budget and no marker.
    await this.owed.clear(sent.to);
    this.nudges.clear(sent.to);
    this.blockedReported.delete(sent.to);
    this.silentAcks.delete(sent.to);
    this.silentAckReported.delete(sent.to);
    this.evaluateAttention(this.now());
    return { conv: sent.to, seq: sent.seq };
  }

  /**
   * §4.3: `pg_ack` — clear a flag without saying anything.
   *
   * A confirmation is worth exactly one thing: it closes the local notification. It does
   * not send a message (so it cannot open a debt at the other end), it does not touch the
   * nudge budget, and it does not end a blocked episode — "not speaking" is itself the
   * thing that has to stay visible, which is why a run of them is reported.
   *
   * `conv` is required: wiping every debt silently is not a default. `seq` may not exceed
   * the largest seq this adapter delivered, named or had read back in that conversation, so
   * a model cannot confirm what it has never been shown — it must `pg_read` first.
   *
   * The bound guards a flag that exists. With nothing owed there is nothing to confirm, and
   * the answer is the ordinary `{cleared: [], remaining}`: the high-water map is memory only
   * (§4.3, Q11), so after a restart a repeated ack would otherwise be refused by a bound
   * that has just forgotten every seq this member ever saw.
   */
  async ack(opts: { conv: string; seq?: number; all?: boolean }): Promise<AckResult> {
    const conv = typeof opts.conv === 'string' ? opts.conv.trim() : '';
    if (conv === '') throw new Error('pg_ack: conv is required (a conversation id such as `dm:<a>_<b>` or `g:<owner>`)');
    const now = this.now();
    const cleared: AckResult['cleared'] = [];

    if (opts.all === true) {
      for (const entry of this.owed.entries()) {
        await this.owed.clear(entry.conv);
        await this.owed.recordAck(entry.conv, entry.seq, now);
        cleared.push({ conv: entry.conv, seq: entry.seq });
        await this.auditSilentAck(entry.conv);
      }
      return { cleared, remaining: this.remainingOwed() };
    }

    const flag = this.owed.entries().find((entry) => entry.conv === conv);
    if (opts.seq !== undefined) {
      if (!Number.isFinite(opts.seq) || opts.seq < 1) {
        throw new Error(`pg_ack: seq must be a positive integer, got ${String(opts.seq)}`);
      }
      const limit = this.owed.maxSeq(conv);
      if (flag !== undefined && opts.seq > limit) {
        throw new Error(
          `pg_ack: seq ${opts.seq} was never named or delivered in ${conv} (the highest is ${limit}); ` +
            `call pg_read on that conversation before confirming a later message`,
        );
      }
    }
    if (flag !== undefined) {
      await this.owed.clear(conv);
      await this.owed.recordAck(conv, flag.seq, now);
      cleared.push({ conv, seq: flag.seq });
      await this.auditSilentAck(conv);
    }
    return { cleared, remaining: this.remainingOwed() };
  }

  /**
   * §4.3: read history backwards, and count what it returned as seen.
   *
   * The ack bound says a model may not confirm a message it was never shown — so reading a
   * message is exactly the act that makes it confirmable. `pg_read` is the exit the bound's
   * own error message points at ("call pg_read on that conversation before confirming a
   * later message"); reading through the platform client alone left that exit closed.
   */
  async read(opts: { conv: string; before?: number; limit?: number }): Promise<string> {
    const conv = typeof opts.conv === 'string' ? opts.conv.trim() : '';
    if (conv === '') throw new Error('pg_read: conv is required (a conversation id such as `dm:<a>_<b>` or `g:<owner>`)');
    const history = await this.pg.messages({ to: conv, before: opts.before, limit: opts.limit });
    for (const message of history.items) this.owed.advance(conv, message.seq);
    return history.items.map((m) => `[${m.to}#${m.seq}] ${m.sender_name}: ${m.body}`).join('\n');
  }

  private remainingOwed(): AckResult['remaining'] {
    return this.owed.entries().map((entry) => ({ conv: entry.conv, seq: entry.seq }));
  }

  /**
   * §4.3: confirmations are silent, so "confirming instead of answering" leaves no trace
   * in any conversation. Three in a row in one conversation, with no reply in between,
   * is reported to the parent once — the report is authored here, so it costs the model
   * no turn, and `say()` is what re-arms it.
   */
  private async auditSilentAck(conv: string): Promise<void> {
    const count = (this.silentAcks.get(conv) ?? 0) + 1;
    this.silentAcks.set(conv, count);
    if (count < SILENT_ACK_LIMIT || this.silentAckReported.has(conv)) return;
    this.silentAckReported.add(conv);
    await this.reportBlocked('silent acking');
  }

  /**
   * Drop every trace of a private conversation with a member that no longer exists.
   * Also drops that member from the cached roster: both callers know the peer is gone
   * from the platform's own answer, so the cache must not keep calling it alive (§4.1).
   */
  private async forgetDm(member: string): Promise<void> {
    this.roster?.ids.delete(member);
    this.roster?.directChildren.delete(member);
    if (this.selfId === undefined) return;
    const conv = dmConv(this.selfId, member);
    await this.owed.clear(conv);
    this.nudges.clear(conv);
    this.blockedReported.delete(conv);
    this.silentAcks.delete(conv);
    this.silentAckReported.delete(conv);
  }

  async spawnMember(opts: {
    name?: string;
    brief: string;
    cwd?: string;
    /** Extra pi argv for the child, appended to the configured spawn command (§2.2). */
    args?: string[];
    /** Esc in the parent's session: stop waiting, not the child that is already started. */
    signal?: AbortSignal;
  }): Promise<{ id: string; name: string }> {
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
    const { pane } = await this.herdr.spawn({ label: name, env, cwd: opts.cwd, args: opts.args, signal: opts.signal });
    this.panes.set(id, pane);
    this.paneCheckedAt.set(id, this.now());
    // Handing work to someone is not waiting for them to start: the child has its brief and a
    // pane, so the caller gets its answer now. Whether it ever connects is a fact that arrives
    // later and is worth interrupting for only if it never does.
    void this.watchSpawnedMember(id, name, pane);
    return { id, name };
  }

  /**
   * Watch a just-spawned child in the background. Success is silent - the child will speak for
   * itself. Failure becomes one line in this member's own context, because a child that never
   * connected is exactly the kind of thing the parent must not have to discover by noticing a
   * silence.
   */
  private async watchSpawnedMember(id: string, name: string, pane: string): Promise<void> {
    const deadline = this.now() + this.config.spawnReadyMs;
    for (;;) {
      try {
        const member = await this.pg.getMember(id);
        if (member.last_seen_at !== null) return;
      } catch {
        // Not a verdict: the next tick may succeed.
      }
      if (this.stopped) return;
      if (this.now() >= deadline) break;
      await sleep(READY_POLL_MS);
    }
    if (this.stopped) return;
    let sawProcess = false;
    try {
      await this.herdr.waitReady(pane, READY_DIAGNOSTIC_MS);
      sawProcess = true;
    } catch {
      sawProcess = false;
    }
    this.enqueue({
      text: sawProcess
        ? `[spawn] ${name} (${id}) is in ${pane} but never connected to ${this.config.url} within ${this.config.spawnReadyMs} ms - it is not a member yet, check its pane`
        : `[spawn] ${name} (${id}) never appeared in ${pane} and never connected within ${this.config.spawnReadyMs} ms - the process did not start`,
      kind: 'nudge',
    });
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

  /**
   * Every direct child, with whatever telemetry has arrived folded in.
   *
   * The platform owns "who my children are"; telemetry only ever reports trouble, so a
   * freshly spawned member that is working quietly has no telemetry entry at all. Listing
   * `telemetry.snapshot()` alone therefore answered `[]` right after `pg_spawn` succeeded -
   * the one moment a parent is most likely to look. The roster is the list; telemetry only
   * fills in the state.
   */
  async children(signal?: AbortSignal): Promise<ChildSnapshot[]> {
    // The tool can be called before the first poll has read whoami; without this the answer
    // would be an empty list that looks exactly like "I have no children".
    await this.ensureReady();
    const self = this.selfId;
    if (self === undefined) return [];
    const known = new Map(this.telemetry.snapshot().map((entry) => [entry.child, entry]));
    const { nodes } = await this.pg.tree(signal);
    return nodes
      .filter((node) => node.parent_id === self)
      .map((node) => {
        const entry = known.get(node.id);
        if (entry === undefined) {
          // Alive, and nothing has gone wrong that it has reported: that is `ok`.
          return { id: node.id, name: node.name, state: 'ok' as const, since: node.last_seen_at ?? 0, count: 0 };
        }
        return {
          id: entry.child,
          name: entry.name,
          state: entry.state === 'recovered' ? ('ok' as const) : entry.state,
          since: entry.stateSince,
          tool: entry.tool,
          count: entry.count,
          last: entry.last,
        };
      });
  }

  /**
   * The live roster behind `pg_members` (概念稿 §7.1). `query` is a case-insensitive
   * substring over the name — the only handle a model has: ids are opaque, and name is
   * the sole index the platform keeps. `total` is the roster size *before* filtering,
   * so `matched: 0` reads as "the query missed", not "nobody exists".
   *
   * `last_seen_at` is copied from the platform unchanged: it is the last time that
   * member authenticated, which proves the token was used, not that the member lives.
   * Liveness is the roster's own filter (`/v1/tree` lists only `alive` members).
   */
  async members(query?: string): Promise<MembersResult> {
    await this.ensureReady();
    const self = this.selfId;
    if (self === undefined) throw new Error('pigroups adapter has no identity yet');
    const tree = await this.pg.tree();
    const nodes = tree.nodes;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const needle = (query ?? '').trim().toLowerCase();
    const rows: RosterMember[] = [];
    for (const node of nodes) {
      const name = typeof node.name === 'string' ? node.name : node.id;
      if (needle !== '' && !name.toLowerCase().includes(needle)) continue;
      rows.push({
        id: node.id,
        name,
        parent_id: typeof node.parent_id === 'string' ? node.parent_id : null,
        parent_name:
          typeof node.parent_id === 'string' ? (byId.get(node.parent_id)?.name ?? null) : null,
        relation: relationOf(node, self, this.parentId),
        child_count: typeof node.child_count === 'number' ? node.child_count : 0,
        last_seen_at: typeof node.last_seen_at === 'number' ? node.last_seen_at : null,
      });
    }
    return { self, total: nodes.length, matched: rows.length, members: rows };
  }

  /**
   * `pg_schedule` (概念稿 §7.5): one in-memory wake, at least 5 s and at most 24 h
   * away, at most eight pending. It is deliberately not persisted: after a restart
   * "should that intention still fire?" is a question nobody can answer.
   *
   * A due wake enters the delivery queue like any other item — it does not bypass the
   * window, so the model may see it a window later than the second it asked for.
   */
  schedule(afterSeconds: number, note: string): ScheduleResult {
    if (!Number.isFinite(afterSeconds)) throw new Error('pg_schedule: after_seconds must be a number');
    if (afterSeconds < SCHEDULE_MIN_SECONDS) {
      throw new Error(`pg_schedule: after_seconds must be at least ${SCHEDULE_MIN_SECONDS} (the tick period)`);
    }
    if (afterSeconds > SCHEDULE_MAX_SECONDS) {
      throw new Error(`pg_schedule: after_seconds must be at most ${SCHEDULE_MAX_SECONDS} (24 hours)`);
    }
    if (note.trim() === '') throw new Error('pg_schedule: note must not be empty');
    if (this.schedules.length >= SCHEDULE_MAX_PENDING) {
      throw new Error(
        `pg_schedule: ${SCHEDULE_MAX_PENDING} wakes are already pending; let one fire instead of adding another`,
      );
    }
    const dueAt = this.now() + Math.round(afterSeconds * 1000);
    this.schedules.push({ dueAt, note });
    return { due_at: dueAt, pending: this.schedules.length };
  }

  /** Move every due wake into the queue. Called by `tick()`, never by a timer of its own. */
  private fireDueSchedules(now: number): void {
    if (this.schedules.length === 0) return;
    const due = this.schedules.filter((wake) => wake.dueAt <= now);
    if (due.length === 0) return;
    this.schedules = this.schedules.filter((wake) => wake.dueAt > now);
    for (const wake of due) this.enqueue({ text: `[scheduled] ${wake.note}`, kind: 'scheduled' });
  }

  state(): { owed: string[]; nudges: Record<string, number> } {
    const owed = this.owed.entries();
    return {
      owed: owed.map((entry) => entry.conv),
      nudges: Object.fromEntries(owed.map((entry) => [entry.conv, this.nudges.count(entry.conv)])),
    };
  }

  /**
   * `pg_terminate`: delete the subtree, close the panes it had spawned, and surface it
   * in telemetry (§5.2).
   *
   * The platform answers with the whole cascade, not just `member`, so the debts and
   * panes of every node it deleted are handled here too: a grandchild this adapter
   * spawned (through the child) would otherwise keep its debt and its pane forever.
   */
  async terminate(member: string): Promise<TerminateResult> {
    const known = this.telemetry.snapshot().find((entry) => entry.child === member);
    const { terminated } = await this.pg.deleteMember(member);
    // The delete has committed as of this line. Everything below is cleanup of a fact:
    // it must not be able to turn a successful `pg_terminate` into a tool error.
    //
    // The members are gone, so their private debts are unpayable. Prune them now rather
    // than at the next roster read: nobody should be nudged once more for a member this
    // call just deleted. `member` is included even if the platform's answer is odd.
    for (const id of new Set([member, ...terminated])) await this.forgetDm(id);
    for (const id of terminated) this.markGone(id, id === member ? known?.name : undefined);
    const pane_close_failed: TerminateResult['pane_close_failed'] = [];
    const pane_close_forced: TerminateResult['pane_close_forced'] = [];
    for (const id of new Set([member, ...terminated])) {
      const outcome = await this.closePane(id);
      if (outcome.failure !== undefined) pane_close_failed.push(outcome.failure);
      if (outcome.forced !== undefined) pane_close_forced.push(outcome.forced);
    }
    return { terminated, pane_close_failed, pane_close_forced };
  }

  /**
   * Close the pane of a member that is already gone, and keep the mapping only while a
   * retry could still succeed (§5.3).
   *
   * A `pane_not_found` is success: the shell the child left behind is already gone, or
   * someone closed it by hand. Any other failure (herdr down, a timeout) leaves the
   * mapping in place so the next `terminate()`/settle tries again, and is reported as
   * `pane_close_failed` instead of failing the committed delete. A close that had to
   * cut a still-working agent is a success too, but it is reported as forced.
   */
  private async closePane(member: string): Promise<PaneCloseOutcome> {
    const pane = this.panes.get(member);
    if (pane === undefined) return {};
    try {
      const result = await this.herdr.close(pane);
      this.panes.delete(member);
      this.paneCheckedAt.delete(member);
      return result.forced ? { forced: { member, pane } } : {};
    } catch (err) {
      return { failure: { member, pane, error: (err as Error)?.message ?? String(err) } };
    }
  }

  /**
   * Confirm the members in the pane map and in the telemetry table are still alive, and
   * close the panes of the ones that are not (§5.3, §5.1 path 3).
   *
   * `terminate()` only sees deletes this adapter issued. A grandparent deleting this
   * adapter's direct child is a legal `DELETE` that never reaches this process, so the
   * map would keep the pane — and the shell in it — forever. `GET /v1/tree` cannot
   * answer this: it is a 30 s snapshot, and absence from a stale snapshot is exactly
   * the false-prune this file now guards against. Ask about each member directly; only
   * an explicit `status:'gone'` closes a pane, so a failed read keeps everything.
   *
   * The telemetry table is checked on its own, never through the pane map: `panes` is
   * only filled by `spawnMember()`, so a parent that restarted has none and a child
   * created by an ancestor never had one. Those are precisely the children whose
   * `error` state has no other way of leaving the table (§5.1: `error` cannot self-clear).
   */
  private async reconcileMembers(): Promise<void> {
    const candidates = new Set<string>(this.panes.keys());
    for (const entry of this.telemetry.snapshot()) {
      if (entry.state !== 'gone') candidates.add(entry.child);
    }
    if (candidates.size === 0) return;
    const now = this.now();
    for (const member of candidates) {
      const checkedAt = this.paneCheckedAt.get(member);
      if (checkedAt !== undefined && now >= checkedAt && now - checkedAt < PANE_CHECK_TTL_MS) continue;
      // Stamped before the request, not after the answer: "每个成员最多每 30 秒查一次" is a
      // bound on the question, not on the reply. A failed read used to leave the timestamp
      // untouched, so an unreachable platform turned every poll (25 s) and every settle into
      // another attempt for every mapped child. It also keeps two concurrent callers apart.
      this.paneCheckedAt.set(member, now);
      try {
        // Bounded like the roster read: a platform that does not answer must not turn
        // the poll/settle path into an unbounded wait.
        const detail = await withTimeout(this.pg.getMember(member), ROSTER_TIMEOUT_MS);
        if (detail.status === 'gone') {
          this.markGone(member, detail.name);
          const outcome = await this.closePane(member);
          if (outcome.failure !== undefined) {
            console.warn(`[pigroups] could not close the pane of gone member ${member}: ${outcome.failure.error}`);
          } else if (outcome.forced !== undefined) {
            console.warn(`[pigroups] closed the pane of gone member ${member} while its agent was still running`);
          }
          continue;
        }
      } catch {
        // Unreachable platform, 404, our own 410: keep the pane and ask again later —
        // one bounded recheck per TTL, not one per poll.
        // A wrong close removes the shell of a living child; a late close loses nothing.
      }
    }
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

  /** §8 startup: identity, briefing, owed reconciliation, journal replay, then the first prune. */
  private async init(): Promise<void> {
    const who = await this.pg.whoami();
    // §8: after the platform answers, a major.minor outside the supported list is
    // one warning, not a refusal. A platform that cannot be reached never gets here;
    // the loop's unreachability reporting owns that case.
    if (!this.compatibilityChecked && typeof who.server?.version === 'string') {
      this.compatibilityChecked = true;
      const warning = platformCompatibilityWarning(who.server.version);
      if (warning !== undefined) console.warn(warning);
    }
    this.selfId = who.member.id;
    this.selfName = who.member.name;
    this.parentId = who.member.parent_id;
    // All three records are this member's (§3.4, §4.2), so they are keyed only now — and
    // read before the first injection point below can decide anything. `hadInjected`
    // separates a fresh spawn from a restart: only a process that has never delivered
    // anything can treat the parent's last DM as the task book (§4.2).
    const hadInjected = await this.watermark.load(who.member.id);
    this.journal.load(who.member.id);
    const hadOwedFile = await this.owed.load(who.member.id);
    await this.injectBrief(!hadInjected);
    // §4.2: the flags on disk are the answer. Only a missing file (first start, or an
    // upgrade from the history-derived version) is reconciled — once, from history.
    // Deriving on every start is what made a debt impossible to confirm: the history can
    // only say who spoke last, so a conversation confirmed with `pg_ack` came back owed.
    if (!hadOwedFile) await this.reconcileObligations();
    await this.replayJournal();
    // §4.1: a peer that died while this member was down is still in the ledger (or in the
    // history the fallback just read). Prune it once here, at the end of startup, so
    // `idle_owed`/`pg_inspect` do not name an unanswerable conversation until the first
    // settle. The roster is read after both, so its absence is conclusive even for a debt
    // the reconciliation has only just marked.
    await this.pruneUnanswerableDms(true);
    this.ready = true;
  }

  /**
   * §8.3: the parent's last DM is read at startup and injected once, without waiting for a
   * window.
   *
   * `freshStart` decides whether that message is the task book `pg_spawn` sent. §4.2 says the
   * brief does not create a debt because the member cannot reply to its own task book — but
   * that holds for the message `spawnMember` sent, not for "whatever the parent said last".
   * A member that was down while its parent wrote an instruction saw that instruction in its
   * context and owed nothing for it: no flag, no `idle_owed`, no nudge, and the next restart
   * forgot it. A process that has never delivered anything (no injection watermark) is the
   * spawn; after that, a parent DM is a message like any other and is owed.
   */
  private async injectBrief(freshStart: boolean): Promise<void> {
    const parent = this.parentId;
    const self = this.selfId;
    if (!parent || !self) return;
    const conv = dmConv(self, parent);
    const history = await this.pg.messages({ to: conv, limit: 1 });
    const brief = history.items[0];
    if (!brief || brief.sender_id !== parent) return;
    this.brief = { conv, seq: brief.seq };
    this.enqueue({
      text: `[${conv}#${brief.seq}] ${brief.sender_name}: ${brief.body}`,
      kind: 'message',
      // 概念稿 §8.4: the brief is the one source that does not wait for a window.
      windowless: true,
      conv,
      seq: brief.seq,
      // §4.2: the task book is not a debt. It is a one-to-one message from the parent, so
      // the delivery rule would make the member owe a reply for the work it was just given.
      noOwed: freshStart,
    });
  }

  /**
   * §4.2's fallback: the §4.1 triggers, read out of history once, when there is no ledger
   * file to trust. A message that is mine proves nothing (I cannot owe myself a reply), and
   * neither does the brief: it is the one `(conv, seq)` the adapter knows by construction.
   */
  private async reconcileObligations(): Promise<void> {
    const self = this.selfId;
    if (!self) return;
    const { items } = await this.pg.conversations();
    const parentId = this.parentId;
    // Read every conversation first and keep the result only in memory. Writing each flag
    // as its read returned made a failed read permanent: the half-written ledger existed
    // on the retry, so `load()` returned true and the conversation whose read had thrown
    // was never visited again (Q9).
    const found: Array<{ conv: string; seq: number }> = [];
    for (const conv of items) {
      const last = await this.pg.messages({ to: conv.to, limit: 1 });
      const message = last.items[0];
      if (!message) continue;
      // The same §4.1 predicate the poll classification uses, so the two cannot
      // disagree — a DM with a sibling owes a reply here too (§4.1's third branch).
      const owed = owesReply({
        conv: conv.to,
        mine: message.sender_id === self,
        mentionsMe: message.mentions.includes(self),
        fromParent: parentId !== null && message.sender_id === parentId,
      });
      if (!owed) continue;
      if (this.brief?.conv === conv.to && this.brief.seq === message.seq) continue;
      found.push({ conv: conv.to, seq: message.seq });
    }
    // Every read succeeded. Only now may the ledger change, and all of it at once.
    const now = this.now();
    for (const entry of found) await this.owed.set(entry.conv, entry.seq, now);
  }

  /** §3.1: replay batches that were journalled but never delivered. */
  private async replayJournal(): Promise<void> {
    for (const entry of await this.journal.pending()) {
      // The entry id goes through `dispatch` so its items register in
      // `queuedByJournal`: without it `commitIfDrained` sees zero and commits a batch
      // that a busy surface or a throwing `deliver` never took — the one copy of it.
      for (const item of entry.batch.items) await this.dispatch(item, entry.id);
      await this.flush();
      // Drained means every item of this entry either reached the agent (released in
      // `deliverPending`) or was dropped by the watermark; anything still queued keeps
      // the entry on disk for the next start (§3.1).
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
    // One message, one injection: the brief came from history, and the copy the poll
    // queue still holds for it is the same message, not new input. `enqueue` then holds
    // the same line for a seq an earlier process already injected (§3.4).
    if (this.brief?.conv === item.to && this.brief.seq === item.seq) return;
    if (
      !owesReply({
        conv: item.to,
        mine: item.from_id === this.selfId,
        mentionsMe: item.mentions_me,
        fromParent: item.from_parent,
      })
    ) {
      this.chatter += 1;
      return;
    }
    this.enqueue({
      text: `[${item.to}#${item.seq}] ${item.from_name}: ${item.preview}`,
      kind: 'message',
      journalId,
      conv: item.to,
      seq: item.seq,
    });
  }

  private classifyGap(item: PollGapItem, journalId?: string): void {
    if (item.mentioned > 0) {
      this.enqueue({
        text: `[${item.to} skipped ${item.count} messages, ${item.mentioned} of them mention you; backfill with pg_read(to, before=${item.before}, limit=20)]`,
        kind: 'message',
        journalId,
        conv: item.to,
        seq: item.before,
        // §3.4: `before` is where to backfill from, not something the model has seen.
        anchor: true,
      });
      return;
    }
    this.chatter += item.count;
  }

  private async handleControl(item: PollControlItem, journalId?: string): Promise<void> {
    const payload = (item.payload ?? {}) as Record<string, unknown>;

    // §6: `v` exists for compatibility only. A `pg.*` command carrying a higher
    // version is a command this adapter does not know, so it is treated exactly like
    // an unknown `cmd` — injected verbatim, never interpreted with v1's rules.
    if (item.cmd.startsWith('pg.') && !isKnownPgVersion(payload.v)) {
      await this.injectUnknownControl(item, payload, journalId);
      return;
    }

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
        await this.abortTurn();
        return;

      case 'pg.steer': {
        // Kept as a wire command, not as a tool (概念稿 §7): a steer is a delivered
        // instruction, so it now enters the queue and waits for the window like any
        // other item. It must NOT abort a busy member any more — `pg_abort` is the
        // only way to change a member that is inside a long tool (§8.2).
        if (!this.fromHigherUp(item)) {
          this.logIgnored(item);
          return;
        }
        const text = typeof payload.text === 'string' ? payload.text : '';
        this.enqueue({ text, kind: 'control', journalId });
        return;
      }

      case 'pg.inspect':
        await this.replyInspect(item, payload);
        return;

      case 'pg.inspect_result':
        this.settleInspect(payload);
        return;

      // §5.1: only a direct child may change what its parent believes about it. A
      // control from anyone else is still injected — nothing is dropped — but it does
      // not touch the telemetry table.
      case 'pg.attention':
        if (!(await this.isDirectChild(item.from_id))) {
          await this.injectIgnoredNonChild(item, payload, journalId);
          return;
        }
        this.applyAttention(payload);
        return;

      // §6: a member's conclusion. `text:"exiting"` is not a conclusion but a state
      // change — the child is on its way out and will never report anything again, so
      // the parent writes `gone` (§5.1 path 2). Every other text stays a readable
      // control line: it is something the member said, not a state.
      case 'pg.report':
        if (payload.text === 'exiting') {
          this.markGone(item.from_id);
          return;
        }
        await this.injectReport(item, payload, journalId);
        return;

      default:
        await this.injectUnknownControl(item, payload, journalId);
        return;
    }

    // A `sys.` command that did not come from `sys` is just an ordinary control.
    await this.injectUnknownControl(item, payload, journalId);
  }

  /**
   * §3.2/§6: a member's conclusion is "一行可读控制" — `status: text` — not a payload dump.
   * The parent has to read the line ("no output after 3 nudges"); `{"v":1,"status":…}` buries
   * it. The JSON stays only as the fallback for a report that carries no text at all, where
   * nothing readable exists to render.
   */
  private async injectReport(
    item: PollControlItem,
    payload: Record<string, unknown>,
    journalId?: string,
  ): Promise<void> {
    const status = typeof payload.status === 'string' ? payload.status.trim() : '';
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const line =
      text === ''
        ? `[report ${item.from_id}] ${status === '' ? item.cmd : status} ${JSON.stringify(payload)}`
        : `[report ${item.from_id}] ${status === '' ? '' : `${status}: `}${text}`;
    this.enqueue({ text: line, kind: 'control', journalId });
  }

  /**
   * §3.2: a command this adapter does not interpret — an unknown `cmd`, or a `pg.*`
   * from a newer version (§6) — is injected verbatim as a control. The adapter does
   * not know the content, so it must not drop it. It enters the delivery window like
   * anything else (概念稿 §8.4: unknown commands go out with the message batch).
   */
  private async injectUnknownControl(
    item: PollControlItem,
    payload: Record<string, unknown>,
    journalId?: string,
  ): Promise<void> {
    this.enqueue({
      text: `[control ${item.from_id}] ${item.cmd} ${JSON.stringify(payload)}`,
      kind: 'control',
      journalId,
    });
  }

  /**
   * §3.2: termination is a cut, not a pause. Abort the running turn before anything
   * else, so pi does not keep waiting for a tool nobody wants any more while the pane
   * is closed underneath it. `aborting` stays set through the discard, stop and
   * shutdown, so a settle that arrives in between cannot deliver a new turn.
   */
  private async discardAndShutdown(payload: Record<string, unknown>): Promise<void> {
    this.aborting = true;
    try {
      await this.cutTurn();
      await this.journal.discard();
      this.pending.length = 0;
      this.queuedByJournal.clear();
      // Nothing is re-delivered after a termination: the member is gone, so a copy
      // that an abort would normally requeue has nowhere to go.
      this.unacknowledged.length = 0;
      await this.stop();
      const reason = typeof payload.reason === 'string' ? payload.reason : 'terminated';
      this.surface.shutdown(reason);
    } finally {
      this.aborting = false;
    }
  }

  /**
   * §3.2: cut the running turn without holding the loop.
   *
   * Control items are handled serially, so an abort that waits for the turn to end
   * parks every later `pg.abort` and `sys.terminated` behind it — and a delivery that
   * started a new turn would keep the wait from ever finishing. Two rules close that:
   * nothing is delivered while `aborting` (`deliverPending` answers `aborting`), and
   * the wait itself is bounded — `surface.abort` gives up after `ABORT_IDLE_TIMEOUT_MS`,
   * this race gives up then or earlier when `stop()` runs. Giving up is not an error:
   * the abort request stands and the turn is still running.
   *
   * 概念稿 §8.3 ①: once the cut is over, the window is forced shut and what is pending
   * goes out at once. The window exists to avoid interrupting work; the abort already
   * stopped the work, so that reason is gone. This is what makes "abort, then say"
   * take effect on the next poll instead of up to a window later.
   */
  private async abortTurn(): Promise<void> {
    this.aborting = true;
    try {
      await this.cutTurn();
    } finally {
      this.aborting = false;
    }
    if (this.stopped) return;
    await this.flushOutcome(true);
    // 概念稿 §8.3 ①: the window's reason is gone once the work was cut, so whatever
    // the abort could not deliver (nothing was pending yet) goes out as soon as it
    // arrives. This is what makes "abort, then say" take effect immediately.
    this.windowImmediate = true;
  }

  /** The bounded cut itself; the caller owns the `aborting` guard. */
  private async cutTurn(): Promise<void> {
    const stop = this.stopGate.signal;
    let onStop: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cut = this.surface.abort(stop).catch((err: unknown) => {
        if (!isAbort(err)) console.warn(`[pigroups] abort failed: ${(err as Error)?.message ?? String(err)}`);
      });
      const expired = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ABORT_IDLE_TIMEOUT_MS);
      });
      const stopped = new Promise<void>((resolve) => {
        if (stop.aborted) return resolve();
        onStop = () => resolve();
        stop.addEventListener('abort', onStop, { once: true });
      });
      await Promise.race([cut, expired, stopped]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onStop !== undefined) stop.removeEventListener('abort', onStop);
    }
  }

  private fromHigherUp(item: PollControlItem): boolean {
    if (this.parentId !== null && item.from_id === this.parentId) return true;
    // Humans are the only other authority (§5.3); their ids are `h_…` (platform §3.1).
    return item.from_id.startsWith('h_');
  }

  /**
   * §5.1: only a direct child may change this member's view of it. Three local facts can
   * prove that relation without a request: this process spawned it (panes), it has
   * reported before (telemetry), or the last roster read named its parent (roster).
   *
   * A miss refreshes the roster at most once per TTL. That covers a child spawned after
   * the snapshot was taken, or one this process did not spawn (a parent that restarted,
   * or a child created by an ancestor). A failed refresh is a closed door, not an open
   * one: the control is still injected as a line, but no state changes until a later read
   * succeeds. There is no "no roster means accept everyone" fallback.
   */
  private async isDirectChild(member: string): Promise<boolean> {
    if (this.isKnownDirectChild(member)) return true;
    const now = this.now();
    const stale = this.roster === undefined || now < this.roster.at || now - this.roster.at >= ROSTER_TTL_MS;
    if (stale && now >= this.childRosterCheckedAt + ROSTER_TTL_MS) {
      // Stamp the attempt before the request: a failed refresh is a closed door for one
      // TTL, not a reason for every following control to ask again.
      this.childRosterCheckedAt = now;
      await this.aliveIds();
    }
    return this.isKnownDirectChild(member);
  }

  private isKnownDirectChild(member: string): boolean {
    if (this.panes.has(member)) return true;
    if (this.telemetry.snapshot().some((entry) => entry.child === member)) return true;
    return this.roster?.directChildren.has(member) ?? false;
  }

  /** §3.2: an ignored state change is still information, so it leaves as a control line. */
  private async injectIgnoredNonChild(
    item: PollControlItem,
    payload: Record<string, unknown>,
    journalId?: string,
  ): Promise<void> {
    console.warn(
      `[pigroups] ignored ${item.cmd} from ${item.from_id}: the sender is not a direct child, ` +
        `so it cannot change this member's state; the control line is injected instead`,
    );
    await this.injectUnknownControl(item, payload, journalId);
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
      owed: this.owed.entries().map((entry) => entry.conv),
      children: this.telemetry.snapshot().length,
      tool: this.tool
        ? { name: this.tool.name, elapsed_ms: now - this.tool.startedAt, preview: this.tool.preview }
        : undefined,
      // 概念稿 §8.5: an answer that omits the last round makes `pg_inspect` blind
      // exactly where it matters — a member stuck inside a tool.
      last: this.lastRound(),
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
      last: isLastRound(payload.last) ? payload.last : undefined,
    });
  }

  /**
   * §5.1: every path to "this child is gone" writes the same row, so the parent cannot
   * tell them apart and none of them can leave a stale state behind. A member this process
   * already reported gone is left alone: the row is deleted once the reminder is delivered,
   * so re-applying would count a second event for the same disappearance (and, with a pane
   * that could not be closed, once per recheck interval for as long as the process lives).
   */
  private markGone(member: string, name?: string): void {
    if (this.goneReported.has(member)) return;
    const known = this.telemetry.snapshot().find((entry) => entry.child === member);
    this.goneReported.add(member);
    const now = this.now();
    this.telemetry.apply(
      { child: member, name: name ?? known?.name ?? member, state: 'gone', since: now },
      now,
    );
  }

  private applyAttention(payload: Record<string, unknown>): void {
    const child = typeof payload.child === 'string' ? payload.child : '';
    const state = attentionStateOf(payload.state);
    if (!child || !state) return;
    // A member this process has already reported gone cannot report anything new. Its
    // remaining events were queued before it died; folding one in would replace the `gone`
    // row with `error` and make the parent wait a whole recheck before learning it is dead.
    if (this.goneReported.has(child)) return;
    const event: AttentionEvent = {
      child,
      name: typeof payload.name === 'string' ? payload.name : child,
      state,
      since: typeof payload.since === 'number' ? payload.since : this.now(),
      of: attentionStateOf(payload.of),
      tool: isAttentionTool(payload.tool) ? payload.tool : undefined,
      owed: Array.isArray(payload.owed) ? payload.owed.filter((c): c is string => typeof c === 'string') : undefined,
      note: typeof payload.note === 'string' ? payload.note : undefined,
      last: isLastRound(payload.last) ? payload.last : undefined,
    };
    this.telemetry.apply(event, this.now());
  }

  // ---- delivery bookkeeping ---------------------------------------------

  private enqueue(item: PendingDelivery): void {
    // §3.4: one rule for all three sources — the startup brief, a polled message and
    // a journal replay all end here, and `(conv, seq)` at or below the watermark was
    // already shown to the model. A gap's `seq` is a backfill anchor: it is checked
    // against the watermark like anything else (a gap whose anchor is already covered
    // is redundant), but `deliverPending` never writes it.
    if (item.conv !== undefined && item.seq !== undefined && this.watermark.seen(item.conv, item.seq)) return;
    this.pending.push(item);
    // 概念稿 §8.1: the first queued item opens the window. A windowless item does not
    // need one, but it still opens it for whatever follows in the same batch.
    if (this.windowStart === null) this.windowStart = this.now();
    if (item.journalId !== undefined) {
      this.queuedByJournal.set(item.journalId, (this.queuedByJournal.get(item.journalId) ?? 0) + 1);
    }
  }

  /**
   * Register a delivery the surface has in hand, so `stop()` can wait for it (§2.3).
   * Both delivery paths — a batch and a nudge — go through here, and this set is the
   * only thing that knows about them.
   */
  private trackDelivery<T>(delivery: Promise<T>): Promise<T> {
    this.deliveries.add(delivery);
    const settle = (): void => {
      this.deliveries.delete(delivery);
    };
    void delivery.then(settle, settle);
    return delivery;
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

  /**
   * Commit an entry only when nothing of it is still queued (§3.1: the entry must
   * outlive a delivery that did not happen). The count, not `flush()`'s return value,
   * decides: a busy surface or a throwing `deliver` gives the items back to `pending`,
   * so they are still counted here, while an entry whose items all reached the agent
   * was already released in `deliverPending`.
   */
  private async commitIfDrained(journalId: string): Promise<void> {
    if ((this.queuedByJournal.get(journalId) ?? 0) === 0) {
      this.queuedByJournal.delete(journalId);
      await this.journal.commit(journalId);
    }
  }

  // ---- settle: reconcile, nudges, telemetry (§4.3, §5.2) -----------------

  /** Subscribe once: a second `start()` must not react twice to one settle (§2.3). */
  private subscribeSettled(): void {
    if (this.settleUnsub !== undefined) return;
    this.settleUnsub = this.surface.onSettled(() => {
      const reaction = this.onSettled().catch((err: unknown) => {
        // A reaction is fire-and-forget: an unhandled rejection here would crash the
        // process instead of failing one settle.
        console.warn(`[pigroups] settle reaction failed: ${(err as Error)?.message ?? String(err)}`);
      });
      this.settles.add(reaction);
      const done = (): void => {
        this.settles.delete(reaction);
      };
      void reaction.then(done, done);
    });
  }

  /**
   * The settle reaction (§2.3): reconcile what only a turn end can reveal, then let
   * the timer scan decide. A settle is no longer a delivery trigger (概念稿 §8.1); it
   * can enqueue a nudge, and that nudge is delivered by the next window.
   *
   * The blocked report (§4.3) stays here because it is adapter-authored: it does not
   * enter the model's context at all, so no window applies to it.
   */
  private async onSettled(): Promise<void> {
    if (this.stopped) return;
    // Before `tick()`: a debt whose peer no longer exists must not reach the reminder
    // or the nudge. Cached, so this is free in the common case.
    await this.pruneUnanswerableDms();
    // `stop()` waits for this reaction, but it sets `stopped` before it waits: do not
    // deliver into a loop that is on its way down.
    if (this.stopped) return;
    await this.reconcileMembers();
    if (this.stopped) return;
    // The window is checked here, by the same scan the 5 s timer runs. Nothing is
    // delivered outside that check — except the two documented cases: the start-up
    // brief (`windowless`) and the forced flush that follows an abort.
    this.tick();
    await this.markNudgeDue();
  }

  /**
   * §4.1: a one-to-one conversation owes a reply only while its peer can receive one.
   * A terminated member answers 410 `member_gone` to every send, so the debt can never
   * be paid — and nothing in the platform withdraws the marker. Left alone it re-nudges
   * for the life of the surviving member: found on a real run, where a child was deleted
   * and its parent kept being told to answer a conversation with nobody on the other end.
   *
   * The roster (`GET /v1/tree`) lists exactly the living members. A read that fails
   * falls back to the last good snapshot; when there is none, or the body is not a
   * roster, every debt is kept: a wrong prune loses a real obligation, a late prune
   * loses nothing.
   *
   * ``since`` guards the other direction. The roster is cached, so a peer created after
   * the read is absent from a list that was true when it was taken. A debt that became
   * owed at or after the snapshot's `at` therefore proves nothing about that peer's
   * existence; only an older debt can be judged by that snapshot.
   *
   * `startup` is the one time the guard does not apply: every debt on disk was recorded by
   * an earlier process, and the fallback reconciliation read its history a moment earlier,
   * so the fresh roster that follows is newer than every debt it judges. A peer absent
   * from that roster is gone even though the debt's `since` is from the same startup.
   */
  private async pruneUnanswerableDms(startup = false): Promise<void> {
    const dms = this.owed.entries().filter((entry) => isDmConv(entry.conv));
    // Startup always reads the roster once: it is also the first evidence of who this
    // member's direct children are (§5.1), and a root has no DM debt to trigger the read.
    // A settle with no DM debt still returns without a request.
    if (dms.length === 0 && !startup) return;
    const roster = await this.aliveIds(startup);
    if (!roster || dms.length === 0) return;

    let changed = false;
    for (const entry of dms) {
      if (!startup && entry.since >= roster.at) continue;
      const peer = dmPeer(entry.conv, this.selfId);
      if (peer === undefined || roster.ids.has(peer)) continue;
      await this.owed.clear(entry.conv);
      this.nudges.clear(entry.conv);
      // The `blocked` episode also ends here: the parent was told this member cannot
      // answer, and that stopped being true the moment the conversation did.
      this.blockedReported.delete(entry.conv);
      changed = true;
    }
    if (changed) this.evaluateAttention(this.now());
  }

  /**
   * The roster, with the instant it describes. Returns the cached snapshot while it is
   * fresh; after a failure it returns the last good snapshot and backs off before
   * asking again. `null` means no trustworthy snapshot exists — the first read failed,
   * or its body was not a roster containing this member.
   *
   * A stale "alive" set is safe to prune with: it removes fewer debts, never more, and
   * the `since >= at` guard still protects a peer created after that snapshot was taken.
   * Discarding it instead would make every failed settle pay another two-second timeout.
   *
   * Validation is not paranoia: `{"nodes":[]}` is a 200 with a truthy body, and treating
   * it as "everyone is gone" clears every DM debt. An answer that does not contain the
   * caller cannot come from a healthy roster, so it prunes nothing.
   */
  private async aliveIds(fresh = false): Promise<RosterSnapshot | null> {
    const now = this.now();
    // `now >= at` rules out a backwards clock step pinning a stale snapshot forever.
    if (!fresh && this.roster && now >= this.roster.at && now - this.roster.at < ROSTER_TTL_MS) return this.roster;
    if (!fresh && now < this.rosterRetryAt) return this.roster ?? null;
    try {
      const tree: unknown = await withAbort((signal) => this.pg.tree(signal), ROSTER_TIMEOUT_MS);
      const nodes = (tree as { nodes?: unknown } | null | undefined)?.nodes;
      if (!Array.isArray(nodes)) return this.rejectRoster();
      const ids = new Set<string>();
      const directChildren = new Set<string>();
      for (const node of nodes) {
        const id = (node as { id?: unknown } | null | undefined)?.id;
        if (typeof id !== 'string' || id === '') return this.rejectRoster();
        ids.add(id);
        const parentId = (node as { parent_id?: unknown } | null | undefined)?.parent_id;
        if (this.selfId !== undefined && parentId === this.selfId) directChildren.add(id);
      }
      if (this.selfId === undefined || !ids.has(this.selfId)) return this.rejectRoster();
      this.roster = { at: now, ids, directChildren };
      this.rosterRetryAt = 0;
      return this.roster;
    } catch {
      return this.rejectRoster();
    }
  }

  /** One bad roster answer: keep the last good one and delay the next request. */
  private rejectRoster(): RosterSnapshot | null {
    this.rosterRetryAt = this.now() + ROSTER_RETRY_BACKOFF_MS;
    return this.roster ?? null;
  }

  /**
   * §4.3: mark that a nudge is due, and report the conversations that have spent
   * their budget. The nudge itself is not delivered here — it is a windowed item
   * (概念稿 §8.4: "窗口关闭，且只在没别的东西可投时"): it opens/takes a window and the
   * timer delivers it when nothing else is in the queue.
   *
   * A settle that leaves queued work does not set the flag: that batch is the wake-up,
   * and a nudge on top would be noise in the same turn. That is the old "`flush()`
   * first, nudge only when it had nothing" rule, expressed on the queue.
   */
  private async markNudgeDue(): Promise<void> {
    // §3.2: an abort is cutting the turn, so a nudge now would be the very turn
    // `surface.abort` then waits for. The flag is set on the next settle instead.
    if (this.aborting || this.stopped) return;
    const owed = this.owed.entries();
    if (owed.length === 0) {
      this.nudgeDue = false;
      return;
    }

    let due = 0;
    for (const entry of owed) {
      const spent = this.nudges.count(entry.conv);
      if (spent >= this.config.nudgeMax) {
        if (!this.blockedReported.has(entry.conv)) {
          this.blockedReported.add(entry.conv);
          await this.reportBlocked(`no output after ${spent} nudges (${entry.conv})`);
        }
        continue;
      }
      due += 1;
    }
    if (due === 0) {
      this.nudgeDue = false;
      return;
    }
    // Queued work is this settle's wake-up; the nudge waits for a window that has
    // nothing else in it. Checked after the blocked report's await, on purpose.
    if (this.pending.length > 0) return;
    // §3.2 again: a `pg.abort` may have landed while the blocked report was in flight.
    if (this.aborting) return;
    this.nudgeDue = true;
    if (this.windowStart === null) this.windowStart = this.now();
  }

  /**
   * The telemetry window expires into one queued reminder (§5.2). It waits for the
   * delivery window like any other item; there is no busy gate, because delivery is a
   * steer now and a busy member is a normal recipient (概念稿 §8.1).
   */
  private queueReminder(now: number): void {
    const decision = this.telemetry.due(now);
    if (decision.kind !== 'remind') return;
    this.enqueue({ text: decision.text, kind: 'nudge' });
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
        this.runningToolPreviews.clear();
        // A provider error sticks until a later turn ends cleanly.
        this.errorNote = event.error ? event.error.message : undefined;
        // 概念稿 §8.3 ②: an aborted turn can swallow a steer that was still queued —
        // the only measured way a delivered message disappears. Put every batch back.
        //
        // Every other end drops the table, a provider error included (§3.4). The rule is
        // "delivered means seen": `sendMessage` is void, so an error proves neither that
        // the model saw a batch nor that it did not, and keeping the copies would make
        // *everything* delivered during that turn suspect until the next abort. Measured
        // on the quant run: that is 31 `(conv, seq)` delivered twice, 29 of them more than
        // two minutes apart (median 650 s, longest 1839 s), all of it replaying batches the
        // model had already acted on. An error is not evidence that the abort dropped them;
        // only `aborted` is (probe/logs/steer-20261101T170244Z).
        if (event.aborted === true) this.requeueUnacknowledged();
        else this.unacknowledged.length = 0;
        this.evaluateAttention(now);
        return;
      case 'tool_start':
        this.tool = { name: event.name, preview: event.argsPreview, startedAt: now };
        this.runningToolPreviews.set(event.name, event.argsPreview);
        return;
      case 'tool_end':
        // Keep the last finished call for the last-round block (§8.5). `tool_end`
        // carries no call id, so a parallel call of the same tool is the one case in
        // which the preview can be another call's; it is a diagnostic, not a fact.
        this.lastTool = {
          name: event.name,
          preview: this.runningToolPreviews.get(event.name) ?? '',
          ok: event.ok,
        };
        this.runningToolPreviews.delete(event.name);
        if (this.tool?.name === event.name) this.tool = undefined;
        this.evaluateAttention(now);
        return;
    }
  }

  /**
   * Put every unacknowledged batch back in front of the queue, in delivery order
   * (概念稿 §8.3 ②). It must bypass `enqueue`: the watermark already advanced past
   * these items when pi accepted them, and that acceptance is exactly what the abort
   * took back.
   *
   * The window is set to "due now" so the next opportunity — the tick, or the forced
   * flush at the end of the abort — delivers them. Duplicates are acceptable; the
   * injected text already carries `[conv#seq]` markers.
   */
  private requeueUnacknowledged(): void {
    const batches = this.unacknowledged.splice(0);
    if (batches.length === 0) return;
    // One unshift of the flattened list keeps the batches in order; unshifting each
    // batch in turn would reverse them.
    this.pending.unshift(...batches.flat());
    this.windowStart = this.now() - this.config.deliveryWindowMs;
  }

  /**
   * The last-round block (概念稿 §8.5): the last assistant text, truncated, and the
   * last finished tool call. `undefined` when the member has produced neither yet.
   */
  private lastRound(): LastRound | undefined {
    const raw = this.surface.lastAssistantText();
    const text = raw === undefined ? undefined : truncate(raw, LAST_TEXT_CHARS);
    const tool = this.lastTool;
    if (text === undefined && tool === undefined) return undefined;
    return {
      ...(text === undefined ? {} : { text }),
      ...(tool === undefined ? {} : { tool }),
    };
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
      const owed = this.owed.entries().filter((entry) => now - entry.since >= this.config.attentionToolMs);
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
    // §8.5: every attention report carries what the last round did, so the state line
    // is never the only thing the parent has to decide with.
    void this.pg
      .sendControl({
        to: parent,
        id: randomUUID(),
        cmd: 'pg.attention',
        payload: { v: 1, child: self, name: this.selfName, ...event, last: this.lastRound() },
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
        // A round that completes without suspending on a macrotask spins the
        // microtask queue: timers never fire, so no timeout anywhere can be
        // observed and the whole pi session stops responding rather than slowing
        // down. Every round yields once so that can never happen — the cost is one
        // immediate callback per round, against a poll that waits seconds.
        if (!this.stopped) await yieldOnce();
      }
    } finally {
      this.inLoop = false;
    }
  }

  private async handlePollError(err: unknown): Promise<void> {
    // A `PgGone` from any other stage of the pull means the same thing as a 410
    // answer (§9): the member is gone, so nothing may keep running.
    if (err instanceof PgGone) {
      await this.goneAndShutdown();
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
      // §9: stop the loops, hand the agent one line, and wait for a human to replace
      // the token. Not the poll's own business — a loop that is not running (no token
      // at all, §7) delivers nothing.
      //
      // The line goes out *before* `stop()`: a stopped loop delivers nothing
      // (`deliverPending` answers `stopped`), so a notice queued afterwards would sit
      // in a dead queue and the model would never learn why the member went silent.
      // `windowless` is the one exception the start-up brief also uses — the window
      // exists to avoid interrupting work, and there is no work left to protect.
      this.pending.push({
        text: 'PIGROUPS token is no longer valid: replace it and restart this session.',
        kind: 'message',
        windowless: true,
      });
      await this.flush();
      await this.stop();
      return;
    }

    console.warn(`[pigroups] poll failed: ${(err as Error)?.message ?? String(err)}`);
    await sleep(1000);
  }

  /** §9: a poll answered 410 `member_gone` — stop everything, then shut the member down. */
  private async goneAndShutdown(): Promise<void> {
    await this.stop();
    this.surface.shutdown('member_gone');
  }
}

function dmConv(a: string, b: string): string {
  const [first, second] = a < b ? [a, b] : [b, a];
  return `dm:${first}_${second}`;
}

/** A one-to-one conversation (§4.1): every message in it is addressed to the peer. */
function isDmConv(conv: string): boolean {
  return conv.startsWith('dm:');
}

/**
 * The other party of a `dm:` conversation id, or `undefined` when it is not one.
 *
 * Do not split at the first `_`: member ids carry one (`m_635f7e`), so the separator
 * between the two ids is not the first underscore in the string. Matching the known
 * half against each end is exact and needs no knowledge of the id format.
 */
function dmPeer(conv: string, selfId: string | undefined): string | undefined {
  if (selfId === undefined || !isDmConv(conv)) return undefined;
  const body = conv.slice(3);
  const prefix = `${selfId}_`;
  if (body.startsWith(prefix)) return body.slice(prefix.length);
  const suffix = `_${selfId}`;
  if (body.endsWith(suffix)) return body.slice(0, body.length - suffix.length);
  return undefined;
}

/**
 * §4.1, the whole definition: a conversation owes a reply when its last message is
 * not mine and one of three holds — it mentions me, my parent sent it, or the
 * conversation is one-to-one. The DM branch is not an optimisation: without it a DM
 * between siblings reads as "said something, nobody owes a reply", which is the most
 * common shape of a silent idle.
 *
 * Both seams use this one predicate — the poll classification (§3.3) and the start-up
 * reconciliation. Two copies drift: the reconciliation used to omit the DM branch and
 * therefore cleared the debt the poll had just set.
 */
function owesReply(input: { conv: string; mine: boolean; mentionsMe: boolean; fromParent: boolean }): boolean {
  if (input.mine) return false;
  return input.mentionsMe || input.fromParent || isDmConv(input.conv);
}

/** §6: `v` absent or 1 is the contract this adapter implements; anything else is unknown. */
function isKnownPgVersion(value: unknown): boolean {
  return value === undefined || value === 1;
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

/** §8.5: a `last` block from a child; anything malformed is dropped, never guessed at. */
function isLastRound(value: unknown): value is LastRound {
  if (typeof value !== 'object' || value === null) return false;
  const last = value as Record<string, unknown>;
  const text = last.text;
  if (text !== undefined && typeof text !== 'string') return false;
  const tool = last.tool;
  if (tool !== undefined) {
    if (typeof tool !== 'object' || tool === null) return false;
    const record = tool as Record<string, unknown>;
    if (typeof record.name !== 'string' || typeof record.preview !== 'string' || typeof record.ok !== 'boolean') {
      return false;
    }
  }
  return text !== undefined || tool !== undefined;
}

/** The structural relation the roster row carries (概念稿 §7.1 ③). */
function relationOf(
  node: { id: string; parent_id?: string | null },
  self: string,
  parent: string | null,
): RosterMember['relation'] {
  if (node.id === self) return 'self';
  if (parent !== null && node.id === parent) return 'parent';
  if (typeof node.parent_id === 'string' && node.parent_id === self) return 'child';
  if (parent !== null && typeof node.parent_id === 'string' && node.parent_id === parent) return 'sibling';
  return 'peer';
}

/**
 * §4.3: every owed conversation in one line, so one wake-up shows all of them. The
 * wording is the one the design pins, and it is English (P7): the recipient is a model,
 * and the way out of the debt is a local action — `pg_ack` — not another message.
 */
function nudgeText(due: OwedFlag[]): string {
  const debts = due.map((entry) => `${entry.conv} #${entry.seq}`).join(', ');
  return `Unanswered messages: ${debts}. Reply, or call pg_ack to clear this notification.`;
}

/** Cut a string to `max` characters, marking that there is more. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
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

/**
 * The same bound, but for a request that can be cancelled. `withTimeout` only abandons
 * the promise: an HTTP fetch keeps its socket and can hold the process open. This hands
 * the request an AbortSignal and aborts it when the timeout fires, so the bound is real.
 */
function withAbort<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, ms);
    run(controller.signal).then(
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
