/**
 * The loop: pull → classify → inject → obligations → telemetry.
 *
 * This module must not import the pi package (设计说明 §1): it only knows
 * `PiSurface`. That is the entire reason this repo is testable.
 */

import { randomUUID } from 'node:crypto';

import { formatLocalMinute } from './format.ts';
import { Journal } from './journal.ts';
import { OwedLedger } from './owed.ts';
import {
  createRespawnLock,
  markChildrenTerminated,
  readChildRecords,
  readRespawnLock,
  readSessionFileForMember,
  removeRespawnLock,
  writeChildRecord,
  writeSessionRecords,
} from './records.ts';
import { NudgeBudget, TelemetryTable } from './state.ts';
import { Watermarks } from './watermark.ts';
import { logWarn, setLogIdentity } from './log.ts';
import type {
  AttentionEvent,
  AttentionState,
  AttentionTool,
  LastRound,
  LastTool,
  RecoverableAttentionState,
  StateSnapshot,
} from './state.ts';
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
import type { Herdr, HerdrPane } from './herdr.ts';
import { ABORT_IDLE_TIMEOUT_MS } from './surface.ts';
import { platformVersionError, platformVersionMatches } from './version.ts';
import type { DeliverKind, PiEvent, PiSurface } from './surface.ts';

export interface MemberStatus {
  /** This member's platform name, the same string on its herdr tab. */
  name: string;
  /** Platform id (`m_…`). */
  id: string;
  /** Root → … → self, names in tree order; always at least `[name]`. */
  path: string[];
  /** Direct children, as the platform counts them. */
  childCount: number;
}

export interface LoopConfig {
  url: string;
  token: string;
  adapterDir: string;
  /** `<adapterDir>/orgs/<orgKey>/`; inherited by spawned children so their records name it. */
  orgKey?: string;
  pollLimit: number;
  pollWait: number;
  /** PIGROUPS_DELIVERY_MAX_CHARS: code points of one message body allowed into the context. */
  deliveryMaxChars: number;
  attentionToolMs: number;
  /** §5.4: how often this member writes its heartbeat. */
  heartbeatMs?: number;
  /** §5.4: how many heartbeat intervals may pass before the parent judges a child not running. */
  heartbeatMiss?: number;
  remindWindowMs: number;
  nudgeMax: number;
  spawnCmd: string;
  /** Tumbling delivery window (概念稿 §8.1): the first queued item opens it. */
  deliveryWindowMs: number;
  /** How long a spawned child gets to authenticate before the parent is told it never did. */
  spawnReadyMs: number;
  /** §12.5: startup settle for the automatic repair (default 30 s). */
  respawnGraceMs?: number;
  /** `null` = the session record says root; `undefined`/string = not a platform owner. */
  parentId?: string | null;
  /**
   * Root-only: ensure the platform when it is unreachable. The loop calls this on
   * the `PgUnavailable` path, never from `session_start`; it returns the current URL.
   */
  ensurePlatform?: () => Promise<string | undefined>;
  /** §12.5: run respawn once at startup when this member has child records. Tests turn it off. */
  autoRespawn?: boolean;
  /** UI-only: the identity line the extension puts in pi's footer status. Never model context. */
  onStatus?: (status: MemberStatus) => void;
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
  /** The state of the latest event; the full picture is `states` (§5.1). */
  state: 'ok' | AttentionState;
  since: number;
  tool?: { name: string; elapsed_ms: number; preview: string };
  owed?: string[];
  note?: string;
  busy_ms?: number;
  count: number;
  /** What that child's last round did (概念稿 §8.5). */
  last?: LastRound;
  /** Every state the child is in: `error` and `blocked` can be true at once (§5.1). */
  states: StateSnapshot[];
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
  /** `ctx.sessionManager.getSessionFile()`; absent when pi has not created a file yet. */
  sessionFile?: string;
  /** Test seam: the unreachable-platform backoff; production uses real time. */
  sleep?: (ms: number) => Promise<void>;
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
 * a caller needs; `tick()` also cares whether the window is still open (`waiting`), a turn
 * is running (`busy`) or an abort is holding delivery (`aborting`).
 */
type FlushOutcome = 'delivered' | 'waiting' | 'busy' | 'aborting' | 'stopped' | 'empty' | 'failed';

const TICK_MS = 5000;
/**
 * At most this many items per `deliver` (§3.5). A size cap, never a trigger: a
 * window that holds more closes, sends this many, and reopens a window for the rest
 * (概念稿 §8.1: count may be a safety valve, never the thing that starts a delivery).
 */
const DELIVER_BATCH = 10;
/**
 * One delivery handed to pi that pi has not echoed yet (概念稿 §8.1, 设计说明 §3.4).
 * Kept only so a send that never produced a `message_end` can be handed over again; the
 * watermark, the debt and the journal entry move on the ack, not on this record.
 */
interface DeliveryInFlight {
  id: string;
  text: string;
  kind: DeliverKind;
  /** The queue items this text carries; empty for a nudge (§4.3). */
  items: PendingDelivery[];
  /** The conversations a nudge named, committed on the ack like the items above. */
  nudged: OwedFlag[];
}
/** §13.5: the last assistant text travels truncated; the tool preview is already 200. */
const LAST_TEXT_CHARS = 500;
/**
 * 概念稿 §3.3/§8.4: the platform now delivers the full body, so the context budget is
 * owned here. 4096 code points was measured on the live organisation: 94.9% of member
 * messages fit, while 1024 would cut half of them.
 */
export const DEFAULT_DELIVERY_MAX_CHARS = 4096;
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
/** §5.4: the member-side heartbeat cadence and the parent-side absence threshold. */
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_HEARTBEAT_MISS = 3;

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

/** `pg_respawn`'s answer (§12.4): readable even when the repair was partial. */
export interface RespawnResult {
  restarted: string[];
  alreadyRunning: string[];
  skipped: Array<{ id: string; reason: string }>;
  failed: Array<{ id: string; error: string }>;
}

/** One child whose repair has something to tell the parent (§12.5). */
interface RepairFact {
  id: string;
  name: string;
  heartbeatAt: number | null;
  lastSeenAt: number | null;
  createdAt: number | null;
  outcome: 'restarted' | 'failed';
  error?: string;
  at: number;
}

interface RespawnRun {
  result: RespawnResult;
  repairs: RepairFact[];
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

/** The panes of one member: retryable failures and closes forced past a live agent. */
interface PaneCloseOutcome {
  failures: Array<{ member: string; pane: string; error: string }>;
  forced: Array<{ member: string; pane: string }>;
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
/** §12.5: the automatic startup settle: controls first, one pane check after it. */
const DEFAULT_RESPAWN_GRACE_MS = 30_000;
/** §12.4: a lock younger than this, held by a live pid, still means "another process is starting it". */
const RESPAWN_LOCK_TTL_MS = 300_000;
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
  private readonly sessionFile: string | undefined;
  private readonly sleepImpl: (ms: number) => Promise<void>;

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
   * The delivery pi has not echoed yet (概念稿 §8.1). At most one: the idle gate forbids a
   * second `deliver` while a turn is running, and a send that started no turn is retried
   * rather than replaced. `undefined` means nothing is waiting for a `delivery_ack`.
   */
  private inFlight: DeliveryInFlight | undefined;
  /**
   * Async commits started by a `delivery_ack`. `flush()` and `stop()` wait for them, so a
   * caller that just saw a delivery go out also sees the watermark and the journal move.
   */
  private readonly commits = new Set<Promise<void>>();
  /** One-shot wakes, in memory only: a restart drops them (§7.5). */
  private schedules: ScheduledWake[] = [];
  /**
   * Child-side edge-triggered running state (§5.1): stalled / slow_turn / error /
   * idle_owed are one at a time, with the precedence in `desiredAttention`.
   */
  private activeRun: { state: AttentionState; since: number; extra: AttentionExtra } | undefined;
  /**
   * Child-side ledger states (`blocked`, `silent_acking`), keyed by state name. Their
   * value is a set of conversations; a set change re-sends the same state (§5.1).
   */
  private readonly ownStates = new Map<AttentionState, { since: number; extra: AttentionExtra }>();
  /** Why each blocked conversation entered the state, so a shrinking set keeps a note. */
  private readonly blockedNotes = new Map<string, string>();
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
  /** When each child's status was last confirmed with `GET /v1/members/{id}` (§5.3). */
  private readonly paneCheckedAt = new Map<string, number>();
  /**
   * Members this process already learned were deleted (`status:'gone'`). A queued claim
   * from one of them describes a world that no longer exists, so it is not folded in.
   * Deletion itself is not an attention state (§5.1): this set only suppresses late news.
   */
  private readonly goneReported = new Set<string>();
  /** When the last heartbeat was started; a failed attempt waits a full interval too. */
  private heartbeatAt = Number.NEGATIVE_INFINITY;
  /** Single-flight: at most one heartbeat request is in the air at a time. */
  private heartbeatInFlight = false;
  /** Distinct heartbeat failures already warned about, so one outage is one line. */
  private readonly heartbeatWarned = new Set<string>();
  /** A `pg.attention{state:'gone'}` claim from this child was already reported. */
  private readonly goneAttentionWarned = new Set<string>();
  /**
   * The last `[repair]` line emitted per child. The key carries both the outcome and the
   * observation that caused it: a retry of the same observation is silent, while a child
   * that dies again later has a new heartbeat and deserves a new line.
   */
  private readonly repairReported = new Map<string, string>();
  /** Starts in flight in this process; prevents two concurrent calls from sharing one stale timestamp. */
  private readonly respawnStarting = new Set<string>();
  /** §12.5 skip reasons already logged by this process; startup runs must not repeat them forever. */
  private readonly respawnSkipWarned = new Set<string>();
  /** §12.5: when the startup grace ends and the automatic path may actually start processes. */
  private autoRespawnDueAt: number | undefined;
  private autoRespawnDone = false;
  /** First successful `whoami`; the startup settle is measured from here. */
  private connectedAt: number | undefined;
  /** Root → self names, filled by `whoami` immediately and by `/v1/tree` when available. */
  private statusPath: string[] = [];
  /**
   * Direct **alive** children for the one-line status. The platform's whoami and
   * `/v1/tree` use the same `status = 'alive'` predicate, so the source may switch
   * without a visible jump. UI only; never used for decisions.
   */
  private statusChildCount = 0;
  /** Incremented on every local child add/remove; keeps an older tree reply from undoing it. */
  private statusEpoch = 0;
  /** A `pg.abort` is cutting the turn: no delivery may start one (§3.2). */
  private aborting = false;
  /** Ends an in-flight abort wait when `stop()` runs (§3.2). */
  private readonly stopGate = new AbortController();
  private readonly eventUnsub: () => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pollAbort: AbortController | undefined;
  private pollConflicts = 0;
  private connectionFailures = 0;
  /** Root-only platform ensure: never two in flight; a whoami demotion disables it. */
  private ensureInFlight = false;
  private rootDemoted = false;

  constructor(deps: LoopDeps) {
    this.pg = deps.pg;
    this.surface = deps.surface;
    this.herdr = deps.herdr;
    this.config = deps.config;
    this.now = deps.now;
    this.sessionFile = deps.sessionFile;
    this.sleepImpl = deps.sleep ?? sleep;
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
    if (this.started) {
      // A session-tree jump can arrive while startup is still failing (the platform was
      // down when the session opened). The poll loop retries on a backoff; a jump is a
      // fresh reason to try the identity/records handshake now, and `ensureReady()`
      // shares any init already in flight. A finished startup is a no-op.
      if (!this.ready) {
        void this.ensureReady().catch((err: unknown) => {
          logWarn(`[pigroups] startup retry failed: ${errorText(err)}`);
        });
      }
      return;
    }
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
    this.pollAbort?.abort();
    // Nothing waits for a turn any more: a control item blocked on `abort()`
    // returns instead of holding the loop (§3.2).
    this.stopGate.abort();
    // The event subscription is dropped *after* the wait below, not here: a delivery the
    // surface is still holding can be echoed while `stop()` waits for it, and that echo
    // is the only thing that commits the batch (概念稿 §8.1). A stopped loop ignores every
    // other event, so nothing can start a turn in the meantime.

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
    // A commit started by a `delivery_ack` is in-flight work too: it is the write that
    // makes the watermark agree with the transcript. Leaving it behind would make a
    // stopped loop look quiet while its own records were still moving.
    for (const commit of this.commits) work.push(commit.catch(() => undefined));
    // Bounded at `STOP_TIMEOUT_MS` (§2.3). Giving up is not an error: the loops are
    // stopped, the delivery stays journalled, and the next start replays it (§3.1).
    await withTimeout(Promise.all(work), STOP_TIMEOUT_MS).catch(() => undefined);
    // A held delivery can settle *while* the wait above runs, and its echo then starts a
    // commit that the snapshot did not name. Wait for those too, under the same bound.
    await withTimeout(this.commitFence(), STOP_TIMEOUT_MS).catch(() => undefined);
    this.eventUnsub();
  }

  /**
   * One pull: journal, classify, dispatch, then let the window decide. `flush()` here
   * only delivers a window that is already due; an item this poll just enqueued opens
   * (or joins) a window and waits for `tick()`.
   */
  async pollOnce(): Promise<void> {
    try {
      await this.ensureReady();
      // A poll is also a drive: if the startup grace expired while the loop was idle,
      // repair this layer now rather than waiting for the next 5 s timer scan.
      this.fireDueAutoRespawn(this.now());
      // The poll loop keeps running while the member is idle, which makes it the one
      // path that can notice an ancestor's delete between settles (§5.3, §5.1 path 3).
      // Bounded by `PANE_CHECK_TTL_MS`, and it returns at once when neither a children
      // record nor a telemetry entry names a member.
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
   * Deliver the current window if it is due (概念稿 §8.1). Nothing goes out while the
   * window is open, while an abort is cutting a turn, or while the agent is busy: one
   * delivery is one `sendMessage` with `triggerTurn`, so it happens at a turn boundary
   * or not at all.
   *
   * Returns whether this call actually delivered. `tick()` is what closes a window in
   * production; tests drive it by advancing the injected clock and calling `tick()`.
   *
   * Single-flight (§2.3): the timer, a tool and a test can call this at the same
   * time. A second caller awaits the batch already in flight instead of splicing its
   * own, which would re-concatenate the taken batch and append the chatter count twice.
   */
  async flush(): Promise<boolean> {
    const outcome = await this.flushOutcome();
    // A delivery is committed by pi's echo, not by `deliver` returning. Waiting for the
    // commit here is what lets a caller read the watermark and the ledger right after a
    // window closed (概念稿 §8.1).
    await this.commitFence();
    return outcome === 'delivered';
  }

  /** The same single-flight call, keeping *why* nothing went out (see `FlushOutcome`). */
  private async flushOutcome(): Promise<FlushOutcome> {
    const inFlight = this.flushInFlight;
    if (inFlight) return inFlight;
    const tracked = this.deliverPending().finally(() => {
      if (this.flushInFlight === tracked) this.flushInFlight = undefined;
    });
    this.flushInFlight = tracked;
    return tracked;
  }

  /**
   * Is there anything a delivery still has to answer for? An un-acknowledged send counts:
   * pi may have failed to prepare the run, and the retry is what keeps the items out of
   * the watermark until they really are in the transcript (§3.4).
   */
  private hasQueuedWork(): boolean {
    return this.pending.length > 0 || this.nudgeDue || this.inFlight !== undefined;
  }

  /** True when the window has run its course (or something in it may not wait). */
  private windowDue(now: number): boolean {
    if (!this.hasQueuedWork()) return false;
    // The start-up brief does not wait for a window (§8.4), and neither does a batch
    // already holding one: they go out together, in one call.
    if (this.pending.some((item) => item.windowless === true)) return true;
    return this.windowStart !== null && now - this.windowStart >= this.config.deliveryWindowMs;
  }

  private async deliverPending(): Promise<FlushOutcome> {
    // A stopped loop delivers nothing: `stop()` is the last step of the delete path and of
    // process exit, and a manual `flush()` must not start a turn behind it.
    if (this.stopped) return 'stopped';
    // §3.2: an abort is cutting the turn. Delivering now would be the very turn the
    // abort then waits for.
    if (this.aborting) return 'aborting';
    if (!this.hasQueuedWork()) {
      this.windowStart = null;
      return 'empty';
    }
    const now = this.now();
    if (!this.windowDue(now)) return 'waiting';
    // 概念稿 §8.1, the whole invariant: one delivery is one `sendMessage` with
    // `triggerTurn`, so it happens at a turn boundary and nowhere else. This check lives
    // here, not at the callers: `tick()`, `ingest`, a tool and a test all arrive through
    // this function, and there is no force path that skips it.
    if (this.surface.isBusy()) return 'busy';

    // §8.4: real items win the window; the nudge is only delivered when there is
    // nothing else to put in front of the model, and otherwise waits for a quiet one.
    //
    // A retry comes first and alone: an un-acknowledged send never entered the
    // transcript, so the same text is safe to hand over again, and new items keep their
    // own window instead of changing a text the previous attempt already named.
    const retry = this.inFlight;
    let text: string;
    let kind: DeliverKind;
    let batch: PendingDelivery[] = [];
    let items: PendingDelivery[];
    let nudged: OwedFlag[] = [];
    if (retry !== undefined) {
      text = retry.text;
      kind = retry.kind;
      items = retry.items;
      nudged = retry.nudged;
    } else if (this.pending.length > 0) {
      batch = this.pending.slice(0, DELIVER_BATCH);
      let joined = batch.map((item) => item.text).join('\n');
      if (this.chatter > 0) joined += `\n[and ${this.chatter} unrelated messages]`;
      text = joined;
      kind = batch.some((item) => item.kind === 'control') ? 'control' : batch[0].kind;
      items = batch;
    } else {
      nudged = this.owableNudges();
      if (nudged.length === 0) {
        this.nudgeDue = false;
        this.windowStart = null;
        return 'empty';
      }
      text = nudgeText(nudged);
      kind = 'nudge';
      items = [];
      // §4.3: the same text as the last nudge this session delivered is not delivered twice. The
      // one `(conv, #seq)` it names is already in the context above, so a repeat adds
      // nothing — it was 61 of the 62 verbatim duplicates measured on a real run. The
      // skip is logged, but it still spends one unit of budget per conversation: a
      // frozen debt must reach `no output after N nudges`, and `idle_owed` does not
      // carry the budget, so a skip that cost nothing would hide the loop from both
      // sides. `lastNudgeText` stays: the next due is still compared with what the
      // model actually saw.
      if (text === this.lastNudgeText) {
        logWarn(
          `[pigroups] skipped a repeated nudge, identical to the last one this session: ${text}`,
        );
        for (const entry of nudged) this.nudges.record(entry.conv);
        this.nudgeDue = false;
        this.windowStart = null;
        return 'empty';
      }
    }

    const id = randomUUID();
    // Set before the send: pi's `message_end` can arrive while `deliver` is still on the
    // stack (the fake in the tests, an idle pi that appends at once), and the ack has to
    // find the record it commits.
    this.inFlight = { id, text, kind, items, nudged };
    try {
      await this.trackDelivery(this.surface.deliver(text, kind, id));
    } catch {
      // Nothing was delivered: a fresh batch stays queued (it was never removed from
      // `pending`) and the window is left as it was so the next flush retries (§9). An
      // un-acknowledged send stays in flight for the same reason.
      if (retry === undefined) this.inFlight = undefined;
      if (retry === undefined && batch.length === 0) this.nudgeDue = true;
      return 'failed';
    }

    if (retry === undefined) {
      if (batch.length > 0) {
        const sent = new Set(batch);
        for (let i = this.pending.length - 1; i >= 0; i -= 1) {
          if (sent.has(this.pending[i])) this.pending.splice(i, 1);
        }
        // The chatter count travels with this text; if the send never reaches the
        // transcript it is re-sent inside the same text, so it is consumed either way.
        this.chatter = 0;
      } else {
        // §4.3: the budget and `lastNudgeText` move on the ack, not here — a nudge whose
        // run never starts must not count, or a frozen debt would reach `blocked` unseen.
        this.nudgeDue = false;
      }
    }
    // A batch cap or a held-back nudge leaves something behind: open the next window
    // now, so the remainder waits a whole window rather than riding this close (§8.1).
    // Read the clock after the delivery: a slow `deliver` must not eat into it. The same
    // window is what an un-acknowledged send waits for before its retry.
    this.windowStart = this.now();
    return 'delivered';
  }

  /**
   * pi echoed one of our messages: it is in the session, so the records may move (§3.4).
   * An id that is not the one in flight is stale (a retry already replaced it) and is
   * ignored: only the newest send can commit.
   */
  private handleDeliveryAck(deliveryId: string): void {
    const delivered = this.inFlight;
    if (delivered === undefined || delivered.id !== deliveryId) return;
    this.inFlight = undefined;
    this.trackCommit(this.commitDelivery(delivered));
  }

  /**
   * Move the records for a batch pi has echoed.
   *
   * Three records are written per item, and the order between them decides which window
   * a crash can land in:
   *
   *   1. the owed flag (§4.2): "a message is in my context and I have not answered it";
   *   2. the injection watermark (§3.4): "this `(conv, seq)` has been shown";
   *   3. the journal entry (§3.1): the only copy of the item — dropped last, so a crash
   *      before it replays the batch.
   *
   * The debt goes first on purpose. A crash between the two writes is possible either way
   * (two files cannot be renamed atomically), so the question is which loss it may cause:
   * flag first → the watermark is behind, the journal replays, the model sees the message
   * twice and `set` keeps the earlier flag; watermark first → the replay is suppressed
   * ("already seen"), the entry is committed and the debt is gone for good. This file
   * chooses the duplicate: "错剪会丢一条真债" is the rule the prune path already follows,
   * and a re-shown `[conv#seq]` costs one turn while a lost flag is silence.
   */
  private async commitDelivery(delivered: DeliveryInFlight): Promise<void> {
    if (delivered.items.length === 0) {
      // §4.3: a delivered nudge counts against the budget and becomes the text a later
      // nudge is compared against. A skipped one was counted where it was skipped.
      this.lastNudgeText = delivered.text;
      for (const entry of delivered.nudged) {
        this.nudges.record(entry.conv);
        // §4.3 / Q11: the nudge named `#seq`, so that seq is now answerable by `pg_ack`
        // even when it never reached the injection watermark (a gap anchor, §3.4).
        this.owed.advance(entry.conv, entry.seq);
      }
      return;
    }
    for (const item of delivered.items) {
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
        // §3.4: the watermark moves only now, after pi echoed the message, so a run that
        // failed to prepare or a crash in between cannot make the message disappear. This
        // is an acknowledgement that pi put the message in the session, not that the model
        // has read it (`sendMessage` is void and swallows start failures; 设计说明 §3.4).
        // A gap is the exception: its `seq` is a backfill anchor, and when nothing was
        // retained the platform sets it to "newest skipped seq + 1" (platform §6.4) —
        // the seq the next real message will carry. Writing it would drop that message
        // as already-seen, and a gap never comes again.
        if (item.seq !== undefined && item.anchor !== true) await this.watermark.advance(item.conv, item.seq);
      }
      if (item.journalId !== undefined) await this.releaseJournal(item.journalId);
    }
  }

  /** Track one ack-driven commit so `flush()`/`stop()` can wait for it. */
  private trackCommit(commit: Promise<void>): void {
    this.commits.add(commit);
    const done = (): void => {
      this.commits.delete(commit);
    };
    void commit.then(done, done);
  }

  /** Wait for every commit already started; a commit does not start another one. */
  private async commitFence(): Promise<void> {
    while (this.commits.size > 0) await Promise.all([...this.commits]);
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
    // §5.4: the heartbeat rides the timer, not a turn. A member stuck in a long tool
    // still tells the parent its loop is alive; a killed process stops without a word.
    this.feedHeartbeat(now);
    this.fireDueAutoRespawn(now);
    this.evaluateAttention(now);
    this.queueReminder(now);
    if (!this.windowDue(now)) return;
    void this.flush().catch((err: unknown) => {
      logWarn(`[pigroups] delivery failed: ${(err as Error)?.message ?? String(err)}`);
    });
  }

  /**
   * §5.4: at most one heartbeat per interval, and never two in flight. The request is
   * fire-and-forget: `tick()` must keep the loop moving even while the platform is
   * slow. A failure is warned once per distinct error, not once per attempt.
   */
  private feedHeartbeat(now: number): void {
    const selfId = this.selfId;
    if (selfId === undefined || this.heartbeatInFlight) return;
    const interval = this.config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    if (now - this.heartbeatAt < interval) return;
    // Stamp the attempt, not the success: a failing platform must not turn every 5 s
    // tick into another request.
    this.heartbeatAt = now;
    this.heartbeatInFlight = true;
    // A platform that accepts the socket and never answers must not hold the in-flight
    // flag forever: the bound releases it, and the next interval tries again.
    void withTimeout(this.pg.heartbeat(selfId), ROSTER_TIMEOUT_MS)
      .catch((err: unknown) => {
        const reason = errorText(err);
        if (this.heartbeatWarned.has(reason)) return;
        this.heartbeatWarned.add(reason);
        logWarn(`[pigroups] heartbeat failed: ${reason}; the loop keeps running`);
      })
      .finally(() => {
        this.heartbeatInFlight = false;
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
    const now = this.now();
    await this.owed.clear(sent.to);
    this.nudges.clear(sent.to);
    this.blockedReported.delete(sent.to);
    this.blockedNotes.delete(sent.to);
    this.silentAcks.delete(sent.to);
    this.silentAckReported.delete(sent.to);
    // §5.2: `blocked` and `silent_acking` are per-conversation sets. `say(conv)` removes
    // only that conversation; a non-empty set is re-sent with what remains, and only an
    // empty set is `recovered{of}`. `pg_ack` deliberately does none of this.
    await this.syncOwnState('blocked', now);
    await this.syncOwnState('silent_acking', now);
    this.evaluateAttention(now);
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
    // §5.2: this is an activity state, not a one-shot notice. It enters when the third
    // real ack lands in this conversation and leaves only when `say(conv)` succeeds.
    this.silentAckReported.add(conv);
    await this.syncOwnState('silent_acking', this.now());
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
    this.blockedNotes.delete(conv);
    this.silentAcks.delete(conv);
    this.silentAckReported.delete(conv);
    // The conversation is gone, so it cannot remain in a state that only `say(conv)`
    // could leave. A state that is now empty recovers; a non-empty one is re-sent.
    const now = this.now();
    await this.syncOwnState('blocked', now);
    await this.syncOwnState('silent_acking', now);
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
    // `children/<childId>.json` must name this member as its parent (§12.3), so the
    // identity has to exist before the record is written.
    await this.ensureReady();
    const parentId = this.selfId;
    if (parentId === undefined) throw new Error('pigroups adapter has no identity yet; cannot spawn a child');
    const requestId = randomUUID();
    const created = await this.pg.createMember({ name: opts.name, request_id: requestId });
    const id = created.member.id;
    const name = created.member.name;
    this.statusEpoch += 1;
    this.statusChildCount += 1;
    this.emitStatus();
    // A replayed create returns no token (platform §12); reissue for the direct child.
    const token = created.token ?? (await this.pg.reissueToken(id)).token;

    await this.say(id, opts.brief);

    const env: Record<string, string> = {
      PIGROUPS_URL: this.pg.url,
      PIGROUPS_TOKEN: token,
      PIGROUPS_ADAPTER_DIR: this.config.adapterDir,
      PIGROUPS_SPAWN_CMD: this.config.spawnCmd,
      ...(this.config.orgKey === undefined ? {} : { PIGROUPS_ORG_KEY: this.config.orgKey }),
    };
    const { pane } = await this.herdr.spawn({ label: name, env, cwd: opts.cwd, args: opts.args, signal: opts.signal });
    try {
      // §12.3: the parent knows the token and the launch recipe, but not the child's
      // session file (the child writes that itself). The record is enough to reopen it.
      writeChildRecord(this.config.adapterDir, {
        parentId,
        childId: id,
        name,
        cwd: opts.cwd ?? null,
        args: opts.args ?? [],
        token,
        intent: 'spawned',
      });
    } catch (err) {
      // The child is already running; a failed record write is a repair problem, not a
      // reason to report the spawn itself as failed.
      logWarn(`[pigroups] could not write the respawn record for ${id}: ${(err as Error)?.message ?? String(err)}`);
    }
    this.paneCheckedAt.set(id, this.now());
    // Handing work to someone is not waiting for them to start: the child has its brief and a
    // pane, so the caller gets its answer now. Whether it ever connects is a fact that arrives
    // later and is worth interrupting for only if it never does.
    void this.watchSpawnedMember(id, name, pane);
    void this.refreshStatusPath();
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
        ? `[spawn] ${name} (${id}) is in ${pane} but never connected to ${this.pg.url} within ${this.config.spawnReadyMs} ms - it is not a member yet, check its pane`
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
          return { id: node.id, name: node.name, state: 'ok' as const, since: node.last_seen_at ?? 0, count: 0, states: [] };
        }
        return {
          id: entry.child,
          name: entry.name,
          state: entry.state === 'recovered' ? ('ok' as const) : entry.state,
          since: entry.stateSince,
          tool: entry.tool,
          owed: entry.owed,
          note: entry.note,
          busy_ms: entry.busy_ms,
          count: entry.count,
          last: entry.last,
          states: entry.states,
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
   * `pg_terminate`: delete the subtree and close the panes it had spawned. The
   * platform's answer is the report; a deletion is not an attention state (§5.1).
   *
   * The platform answers with the whole cascade, not just `member`, so the debts and
   * panes of every node it deleted are handled here too: a grandchild this adapter
   * spawned (through the child) would otherwise keep its debt and its pane forever.
   */
  async terminate(member: string): Promise<TerminateResult> {
    const { terminated } = await this.pg.deleteMember(member);
    // The delete has committed as of this line. Everything below is cleanup of a fact:
    try {
      // §12.3: `intent:terminated` is what keeps "run automatically at startup" from
      // turning a terminate into a suggestion. The record stays; only its intent changes.
      markChildrenTerminated(this.config.adapterDir, [member, ...terminated]);
    } catch (err) {
      logWarn(`[pigroups] could not mark terminated members in children/: ${(err as Error)?.message ?? String(err)}`);
    }
    // it must not be able to turn a successful `pg_terminate` into a tool error.
    //
    // The members are gone, so their private debts are unpayable. Prune them now rather
    // than at the next roster read: nobody should be nudged once more for a member this
    // call just deleted. `member` is included even if the platform's answer is odd.
    for (const id of new Set([member, ...terminated])) await this.forgetDm(id);
    for (const id of terminated) this.markGone(id);
    const pane_close_failed: TerminateResult['pane_close_failed'] = [];
    const pane_close_forced: TerminateResult['pane_close_forced'] = [];
    for (const id of new Set([member, ...terminated])) {
      const outcome = await this.closePane(id);
      pane_close_failed.push(...outcome.failures);
      pane_close_forced.push(...outcome.forced);
    }
    this.statusEpoch += 1;
    void this.refreshStatusPath();
    return { terminated, pane_close_failed, pane_close_forced };
  }

  /**
   * §12.4: reopen this member's direct children and tell each one to repair its own
   * layer. It never calls `POST /v1/members/:id/token`: reissuing a token overwrites
   * `token_hash`, which logs a living child out. The recorded token is used as-is.
   *
   * The only running evidence is a herdr pane whose `agent_session.value` is the
   * child's session file. `respawnStarting` and the on-disk lock cover the window
   * before that pane exists; there is no heartbeat/freshness gate and no failure
   * cooldown.
   *
   * `allowStart:false` marks the automatic startup settle: until `connectedAt + grace`
   * it sends controls only. After the settle (or for the manual tool, immediately) a
   * readable pane list with no matching pane starts the child; an unreadable list only
   * sends the control.
   */
  async respawn(scope?: string, opts: { allowStart?: boolean } = {}): Promise<RespawnResult> {
    return (await this.performRespawn(scope, opts)).result;
  }

  private async performRespawn(scope?: string, opts: { allowStart?: boolean } = {}): Promise<RespawnRun> {
    const result: RespawnResult = { restarted: [], alreadyRunning: [], skipped: [], failed: [] };
    const repairs: RepairFact[] = [];
    // The filter needs this member's id; a direct call (a test, or a control that won
    // the race with the first poll) may arrive before `init()` has run.
    await this.ensureReady();
    const selfId = this.selfId;
    if (selfId === undefined) {
      result.skipped.push({ id: scope ?? 'self', reason: 'this adapter has no identity yet; nothing to respawn' });
      return { result, repairs };
    }

    let records = readChildRecords(this.config.adapterDir, selfId);
    if (scope !== undefined && scope !== '') {
      const selected = records.filter((record) => record.childId === scope);
      if (selected.length === 0) {
        result.skipped.push({
          id: scope,
          reason: 'not a direct child of this member; respawn only handles children recorded by pg_spawn',
        });
        return { result, repairs };
      }
      records = selected;
    }

    for (const record of records) {
      const id = record.childId;
      if (record.intent === 'terminated') {
        result.skipped.push({ id, reason: 'intent is terminated; a terminated member is never started automatically' });
        continue;
      }
      if (this.respawnStarting.has(id)) {
        result.alreadyRunning.push(id);
        continue;
      }

      // §12.4: the platform's view is a courtesy, not the decision. A transient
      // `getMember` failure must not hide a child whose pane is already there; a
      // 404/410 is a verdict and skips it.
      let detail: Awaited<ReturnType<PgClient['getMember']>> | undefined;
      try {
        detail = await this.pg.getMember(id);
      } catch (err) {
        if (err instanceof PgError && (err.status === 404 || err.status === 410)) {
          result.skipped.push({ id, reason: `member is gone (${err.status} ${err.code})` });
          continue;
        }
        detail = undefined;
      }
      if (this.respawnStarting.has(id)) {
        result.alreadyRunning.push(id);
        continue;
      }
      if (detail?.status === 'gone') {
        result.skipped.push({
          id,
          reason: 'member is gone; its identity cannot be restored (the platform will not reissue a gone token)',
        });
        continue;
      }

      // §12.5: the automatic startup pass sends controls first and starts nothing
      // during the settle. Its one-shot `fireDueAutoRespawn` runs the real pass after
      // the window. A control-triggered run during the same window defers the same way.
      if (opts.allowStart === false) {
        const graceMs = this.config.respawnGraceMs ?? DEFAULT_RESPAWN_GRACE_MS;
        const connectedAt = this.connectedAt;
        const graceEndsAt = connectedAt === undefined ? undefined : connectedAt + graceMs;
        if (graceEndsAt === undefined || this.now() < graceEndsAt) {
          try {
            await this.sendRespawnControl(id);
            result.skipped.push({
              id,
              reason:
                `startup settle (${graceMs} ms): controls only until the pane list can be trusted; ` +
                'pg_respawn starts it now',
            });
            if (graceEndsAt !== undefined) this.autoRespawnDueAt = graceEndsAt;
            this.autoRespawnDone = false;
          } catch (err) {
            result.failed.push({ id, error: respawnError(err) });
          }
          continue;
        }
      }

      const heartbeatAt = typeof detail?.heartbeat_at === 'number' ? detail.heartbeat_at : null;
      const lastSeen = typeof detail?.last_seen_at === 'number' ? detail.last_seen_at : null;

      const sessionFile = readSessionFileForMember(this.config.adapterDir, id);
      if (sessionFile === undefined) {
        result.skipped.push({
          id,
          reason: 'no session record for this member; cannot reopen it without a session file (no path is guessed)',
        });
        continue;
      }

      // §12.4/C: `pane list` is the only fact that separates "not started" from
      // "already running". A pane whose agent runs this child's session file is the
      // child; notify it, never start a second process. `null` means herdr could not
      // ask, and an unknown answer is never evidence that the child is absent.
      let panes: HerdrPane[] | null;
      try {
        panes = await this.herdr.listPanes();
      } catch {
        panes = null;
      }
      if (panes !== null && panes.some((pane) => pane.agent_session?.value === sessionFile)) {
        try {
          await this.sendRespawnControl(id);
          result.alreadyRunning.push(id);
        } catch (err) {
          result.failed.push({ id, error: respawnError(err) });
        }
        continue;
      }
      if (panes === null) {
        // Never start a process on an unknown answer, not even for an explicit
        // `pg_respawn` or after the startup settle: a second process on one identity
        // is the exact mistake this check exists to prevent.
        try {
          await this.sendRespawnControl(id);
          result.skipped.push({
            id,
            reason: 'herdr could not list panes; control sent, no process started while the answer is unknown',
          });
        } catch (err) {
          result.failed.push({ id, error: respawnError(err) });
        }
        continue;
      }

      const lock = this.acquireRespawnLock(id);
      if (!lock.acquired) {
        result.skipped.push({
          id,
          reason: `another process is starting it (lock held by pid ${lock.pid} at ${lock.at})`,
        });
        continue;
      }

      this.respawnStarting.add(id);
      let pane: string | undefined;
      try {
        const spawned = await this.herdr.spawn({
          label: record.name,
          env: {
            PIGROUPS_URL: this.pg.url,
            PIGROUPS_TOKEN: record.token,
            PIGROUPS_ADAPTER_DIR: this.config.adapterDir,
            PIGROUPS_SPAWN_CMD: this.config.spawnCmd,
            ...(this.config.orgKey === undefined ? {} : { PIGROUPS_ORG_KEY: this.config.orgKey }),
          },
          cwd: record.cwd ?? undefined,
          // §12.4/§D-13: `--session` comes first. Caller args may contain `--`, which
          // would otherwise turn the flag into a positional argument.
          args: ['--session', sessionFile, ...record.args],
        });
        pane = spawned.pane;
        // `pane` stays local: no pane id is stored. The session record and `pane list`
        // are what a later close uses, exactly as for `pg_spawn`.
        this.paneCheckedAt.set(id, this.now());
        // D1: do not tell it to repair its own children until it has authenticated.
        // A member that has not connected can only produce a string of failures.
        await this.waitForRespawnConnection(id, lastSeen);
        await this.sendRespawnControl(id);
        result.restarted.push(id);
        repairs.push({
          id,
          name: record.name,
          heartbeatAt,
          lastSeenAt: lastSeen,
          createdAt: typeof detail?.created_at === 'number' ? detail.created_at : null,
          outcome: 'restarted',
          at: this.now(),
        });
      } catch (err) {
        // A spawn can fail after the pane exists (the session never authenticates, or
        // the recursive control cannot be sent). Close it before reporting the failed
        // attempt: leaving it behind is the shell a dead child's parent must not keep.
        const error = respawnError(err);
        if (pane !== undefined) {
          try {
            await this.herdr.close(pane);
          } catch (closeError) {
            logWarn(`[pigroups] could not close pane ${pane} of ${id}: ${respawnError(closeError)}`);
          }
        }
        result.failed.push({ id, error });
        repairs.push({
          id,
          name: record.name,
          heartbeatAt,
          lastSeenAt: lastSeen,
          createdAt: typeof detail?.created_at === 'number' ? detail.created_at : null,
          outcome: 'failed',
          error,
          at: this.now(),
        });
      } finally {
        this.respawnStarting.delete(id);
        // Always remove our own lock: success, failure and a thrown close all end the
        // "another process is starting it" claim. A lock left behind would block the
        // next repair for five minutes.
        removeRespawnLock(this.config.adapterDir, id);
      }
    }
    return { result, repairs };
  }

  /**
   * Claim `<adapterDir>/respawn/<childId>.lock` (§12.4). A fresh lock held by a live pid
   * belongs to another process; an expired one, a dead pid, or a corrupt file is cleaned
   * up and retried once, so a crashed starter cannot block the repair forever.
   */
  private acquireRespawnLock(id: string): { acquired: true } | { acquired: false; pid: number; at: number } {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const now = this.now();
      if (createRespawnLock(this.config.adapterDir, id, { pid: process.pid, at: now })) return { acquired: true };
      const existing = readRespawnLock(this.config.adapterDir, id);
      if (existing !== undefined && now - existing.at < RESPAWN_LOCK_TTL_MS && processIsAlive(existing.pid)) {
        return { acquired: false, pid: existing.pid, at: existing.at };
      }
      removeRespawnLock(this.config.adapterDir, id);
    }
    const existing = readRespawnLock(this.config.adapterDir, id);
    return { acquired: false, pid: existing?.pid ?? 0, at: existing?.at ?? 0 };
  }

  /** One parent-to-child `pg.respawn`; the child runs §12.4 for its own layer. */
  private async sendRespawnControl(member: string): Promise<void> {
    await this.pg.sendControl({
      to: member,
      id: randomUUID(),
      cmd: 'pg.respawn',
      payload: { v: 1 },
    });
  }

  /** Wait for `last_seen_at` to advance past what the member had before this launch. */
  private async waitForRespawnConnection(member: string, before: number | null): Promise<void> {
    // §12.4/F10: the deadline is on the loop's clock. Production injects `Date.now`;
    // tests inject a fake clock and can end the wait by advancing it, not by sleeping.
    const deadline = this.now() + this.config.spawnReadyMs;
    for (;;) {
      try {
        const detail = await this.pg.getMember(member);
        const seen = typeof detail.last_seen_at === 'number' ? detail.last_seen_at : null;
        if (seen !== null && (before === null || seen > before)) return;
      } catch {
        // Not a verdict; the next read may succeed.
      }
      if (this.now() >= deadline) {
        throw new Error(`session started but did not authenticate within ${this.config.spawnReadyMs} ms`);
      }
      await sleep(READY_POLL_MS);
    }
  }

  /**
   * §12.5: startup repairs this layer in the background; it must not block `init()`.
   * The first pass sends controls and starts nothing during the settle measured from
   * the first successful `whoami`; `fireDueAutoRespawn` runs the real pane check once
   * after that window.
   */
  private maybeAutoRespawn(): void {
    if (this.config.autoRespawn !== true || this.autoRespawnDone) return;
    const selfId = this.selfId;
    if (selfId === undefined) return;
    if (readChildRecords(this.config.adapterDir, selfId).length === 0) {
      this.autoRespawnDone = true;
      return;
    }
    this.autoRespawnDone = true;
    this.autoRespawnDueAt = undefined;
    this.runRespawnInBackground(undefined, { allowStart: false });
  }

  /** The grace has expired: run the automatic repair for real. Called by `tick()`. */
  private fireDueAutoRespawn(now: number): void {
    if (this.autoRespawnDueAt === undefined || now < this.autoRespawnDueAt) return;
    this.autoRespawnDueAt = undefined;
    this.autoRespawnDone = true;
    this.runRespawnInBackground();
  }

  /** A control or startup repair is a background job: the loop must keep handling abort/terminate. */
  private runRespawnInBackground(scope?: string, opts: { allowStart?: boolean } = {}): void {
    this.runRespawnJobs([() => this.performRespawn(scope, opts)]);
  }

  /**
   * One cascade is one repair pass. The children are repaired in the order the pass
   * found them, one `performRespawn` after another - the same ordering guarantee the
   * startup path gives by looping over the records instead of starting them at once.
   */
  private runRespawnJobs(jobs: Array<() => Promise<RespawnRun>>): void {
    void (async () => {
      const result: RespawnResult = { restarted: [], alreadyRunning: [], skipped: [], failed: [] };
      const repairs: RepairFact[] = [];
      for (const job of jobs) {
        const run = await job();
        result.restarted.push(...run.result.restarted);
        result.alreadyRunning.push(...run.result.alreadyRunning);
        result.skipped.push(...run.result.skipped);
        result.failed.push(...run.result.failed);
        repairs.push(...run.repairs);
      }
      return { result, repairs };
    })()
      .then(({ result, repairs }) => {
        // §12.5/F8: a skip in the background is invisible unless it is logged. Dedup per
        // process: startup runs on every session start, and a tombstone must not fill the log.
        for (const skipped of result.skipped) {
          const key = `${skipped.id}\u0000${skipped.reason}`;
          if (this.respawnSkipWarned.has(key)) continue;
          this.respawnSkipWarned.add(key);
          logWarn(`[pigroups] respawn skipped ${skipped.id}: ${skipped.reason}`);
        }
        for (const failed of result.failed) {
          logWarn(`[pigroups] respawn of ${failed.id} failed: ${failed.error}`);
        }
        this.reportRepairs(repairs);
      })
      .catch((err: unknown) => {
        logWarn(`[pigroups] respawn failed: ${respawnError(err)}`);
      });
  }

  /**
   * §12.5: a repair the model cannot see is a repair that did not communicate. One
   * line per child per death; a retry of the same observation is already in the
   * conversation, so it does not repeat, but a child that dies again later has a new
   * heartbeat and is news. The line carries both halves the parent needs: the observed
   * fact and what this process did about it.
   */
  private reportRepairs(repairs: RepairFact[]): void {
    if (this.stopped) return;
    for (const repair of repairs) {
      const outcome = repair.outcome === 'restarted' ? 'restarted' : `failed:${repair.error ?? 'unknown error'}`;
      // The observation is part of the key: `heartbeat_at`/`last_seen_at` move when the
      // child really dies again, while a retry sees exactly the same values.
      const observation = `${repair.heartbeatAt ?? 'null'}\u0000${repair.lastSeenAt ?? 'null'}`;
      const key = `${outcome}\u0000${observation}`;
      if (this.repairReported.get(repair.id) === key) continue;
      this.repairReported.set(repair.id, key);
      const since = repair.heartbeatAt ?? repair.lastSeenAt ?? repair.createdAt;
      const sinceText = since === null ? 'unknown' : formatLocalMinute(since);
      const end =
        repair.outcome === 'restarted'
          ? `restarted ${formatLocalMinute(repair.at).slice(11)}`
          : `restart failed: ${repair.error ?? 'unknown error'}`;
      this.enqueue({
        text: `[repair] ${repair.id} (${repair.name}) was not running (no heartbeat since ${sinceText}); ${end}`,
        kind: 'nudge',
      });
    }
  }

  /**
   * Close every pane of a member that is already gone (§5.3).
   *
   * The adapter stores no pane id: it does not survive a restart, and a cached id can
   * point at a pane that no longer exists. The identity that does survive is the session
   * file `sessions/by-member/<id>.json`, which `pane list` reports as
   * `agent_session.value`; every pane carrying that file is this member's (respawn and
   * herdr's own restore can leave more than one).
   *
   * Only when there is no session record does the label become a fallback. It is weaker,
   * so a pane carrying another living member's session file is excluded; that set is
   * computed now from `children/` and `sessions/by-member/`, never cached.
   *
   * A `pane_not_found` is success: the shell the child left behind is already gone, or
   * someone closed it by hand. Any other failure (herdr down, a timeout) is reported as
   * `pane_close_failed` instead of failing the committed delete. A close that had to cut
   * a still-working agent is a success too, but it is reported as forced. A list that
   * cannot be read, or names no pane, closes nothing and is not a failure: the delete is
   * already a fact.
   */
  private async closePane(member: string): Promise<PaneCloseOutcome> {
    const sessionFile = readSessionFileForMember(this.config.adapterDir, member);

    // `listPanes()` is promised not to throw, but a fake or an older implementation may;
    // a committed delete must not fail here. `null` means "could not ask": there is
    // nothing to close and that is not a close failure.
    let listed: HerdrPane[] | null = null;
    try {
      listed = await this.herdr.listPanes();
    } catch (err) {
      logWarn(`[pigroups] could not list herdr panes for ${member}: ${(err as Error)?.message ?? String(err)}`);
    }
    if (listed === null) return { failures: [], forced: [] };

    const targets = new Set<string>();
    if (sessionFile !== undefined) {
      for (const pane of listed) {
        if (pane.agent_session?.value === sessionFile) targets.add(pane.pane_id);
      }
    } else {
      // No session record: the label is the only handle. It is weaker than the file, so
      // never close a pane that another living member's session file names.
      const name = this.memberName(member);
      if (name !== undefined) {
        const otherSessions = this.otherLiveSessionFiles(member);
        for (const pane of listed) {
          if (!paneMatchesName(pane, name)) continue;
          const paneSession = pane.agent_session?.value;
          if (paneSession !== undefined && otherSessions.has(paneSession)) continue;
          targets.add(pane.pane_id);
        }
      }
    }

    const failures: PaneCloseOutcome['failures'] = [];
    const forced: PaneCloseOutcome['forced'] = [];
    for (const pane of targets) {
      try {
        const result = await this.herdr.close(pane);
        if (result.forced) forced.push({ member, pane });
      } catch (err) {
        failures.push({ member, pane, error: (err as Error)?.message ?? String(err) });
      }
    }
    return { failures, forced };
  }

  /** The name this adapter knows for a member, for the session-file-less fallback. */
  private memberName(member: string): string | undefined {
    // The child record is the label `spawnMember` actually passed to herdr. Prefer it;
    // telemetry may only know the id.
    if (this.selfId !== undefined) {
      const record = readChildRecords(this.config.adapterDir, this.selfId).find((entry) => entry.childId === member);
      if (record !== undefined) return record.name;
    }
    const known = this.telemetry.snapshot().find((entry) => entry.child === member);
    if (known !== undefined && known.name !== '' && known.name !== member) return known.name;
    return undefined;
  }

  /**
   * Session files of every other member this adapter still considers alive. Used only by
   * the name fallback: a pane is that member's when herdr says its agent runs that file.
   * Both sources are durable (`children/`) or written by the member itself
   * (`sessions/by-member/`); nothing here comes from a pane id cache.
   */
  private otherLiveSessionFiles(member: string): Set<string> {
    const files = new Set<string>();
    const others = new Set<string>();
    if (this.selfId !== undefined) {
      for (const record of readChildRecords(this.config.adapterDir, this.selfId)) others.add(record.childId);
    }
    for (const entry of this.telemetry.snapshot()) others.add(entry.child);
    for (const other of others) {
      if (other === member || this.goneReported.has(other)) continue;
      const file = readSessionFileForMember(this.config.adapterDir, other);
      if (file !== undefined) files.add(file);
    }
    return files;
  }

  /**
   * The 30 s cleanup scan: close the panes of children the platform says are deleted
   * (§5.3), and forget their telemetry rows. It never starts a process and never
   * judges death from a heartbeat.
   *
   * `terminate()` only sees deletes this adapter issued. A grandparent deleting this
   * adapter's direct child is a legal `DELETE` that never reaches this process; the
   * `children/` record survives a restart, so it keeps that child in the recheck even
   * when telemetry is empty. Ask about each member directly; only an explicit
   * `status:'gone'` closes a pane, so a failed read keeps everything.
   *
   * Telemetry contributes the children this member did not spawn or record (a child
   * created by an ancestor), whose `error` state has no other way of leaving the table.
   */
  private async reconcileMembers(): Promise<void> {
    const records =
      this.selfId === undefined ? [] : readChildRecords(this.config.adapterDir, this.selfId);
    const candidates = new Set<string>(records.map((record) => record.childId));
    for (const entry of this.telemetry.snapshot()) candidates.add(entry.child);
    if (candidates.size === 0) return;
    const now = this.now();
    let sawGone = false;

    for (const member of candidates) {
      const checkedAt = this.paneCheckedAt.get(member);
      if (checkedAt !== undefined && now >= checkedAt && now - checkedAt < PANE_CHECK_TTL_MS) continue;
      // Stamped before the request, not after the answer: "每个成员最多每 30 秒查一次" is a
      // bound on the question, not on the reply. It also keeps two concurrent callers apart.
      this.paneCheckedAt.set(member, now);
      try {
        // Bounded like the roster read: a platform that does not answer must not turn
        // the poll/settle path into an unbounded wait.
        const detail = await withTimeout(this.pg.getMember(member), ROSTER_TIMEOUT_MS);
        if (detail.status !== 'gone') continue;
        this.markGone(member);
        this.statusEpoch += 1;
        sawGone = true;
        const outcome = await this.closePane(member);
        for (const failure of outcome.failures) {
          logWarn(`[pigroups] could not close pane ${failure.pane} of gone member ${member}: ${failure.error}`);
        }
        for (const forced of outcome.forced) {
          logWarn(`[pigroups] closed pane ${forced.pane} of gone member ${member} while its agent was still running`);
        }
        // The row only existed to keep a telemetry-only child in this recheck. Forget
        // it after closePane: the name fallback still needs it to find the last pane
        // when the child has no session record. Once the platform says gone, keeping
        // it would ask about a dead child forever.
        this.telemetry.forget(member);
      } catch (err) {
        // A 404 is the platform's other way of saying the member is gone; drop the
        // telemetry row like the explicit `status:'gone'` branch above.
        if (err instanceof PgError && err.status === 404) this.telemetry.forget(member);
        // Unreachable platform, our own 410: keep the pane and ask again later — one
        // bounded recheck per TTL, not one per poll. A wrong close removes the shell of
        // a living child; a late close loses nothing.
      }
    }
    if (sawGone) void this.refreshStatusPath();
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
    setLogIdentity(who.member.name, who.member.id);
    // No compatibility range: a platform from another release is the wrong layer,
    // not a warning. Fail before identity, journal, or delivery work is touched.
    if (typeof who.server?.version !== 'string' || !platformVersionMatches(who.server.version)) {
      throw new Error(platformVersionError(typeof who.server?.version === 'string' ? who.server.version : 'unknown'));
    }
    this.connectedAt = this.now();
    this.selfId = who.member.id;
    this.selfName = who.member.name;
    this.parentId = who.member.parent_id;
    this.statusPath = [who.member.name];
    this.statusChildCount = typeof who.member.child_count === 'number' ? who.member.child_count : 0;
    this.emitStatus();
    // §12.3: the local record decides whether this session may own the platform;
    // whoami may only demote. A record that says child never starts one, even if
    // the token happens to name a root.
    if (this.config.parentId === null && who.member.is_root !== true) {
      this.rootDemoted = true;
      logWarn('[pigroups] session record says root, but whoami does not; this session will not start the platform');
    } else if (typeof this.config.parentId === 'string' && who.member.is_root === true) {
      logWarn('[pigroups] session record says child, but whoami says root; this session will not start the platform');
    }
    // §12.3: a session that has an identity records it under the one key it will still
    // know after a restart. No session file means there is no honest key — do not invent one.
    if (this.sessionFile !== undefined && this.sessionFile !== '') {
      writeSessionRecords(this.config.adapterDir, {
        memberId: who.member.id,
        orgUrl: this.pg.url,
        token: this.config.token,
        parentId: typeof this.config.parentId === 'string' ? this.config.parentId : who.member.parent_id,
        sessionFile: this.sessionFile,
        ...(this.config.orgKey === undefined ? {} : { orgKey: this.config.orgKey }),
      });
    } else {
      logWarn(
        '[pigroups] not writing session respawn records: pi did not provide a session file for this session',
      );
    }
    // All three records are this member's (§3.4, §4.2), so they are keyed only now — and
    // read before the first injection point below can decide anything. `hadInjected`
    // separates a fresh spawn from a restart: only a process that has never delivered
    // anything can treat the parent's last DM as the task book (§4.2).
    const hadInjected = await this.watermark.load(who.member.id);
    this.journal.load(who.member.id);
    const hadOwedFile = await this.owed.load(who.member.id);
    // Identity and the on-disk records above are the prerequisites for respawn. The
    // rest are courtesies: one failing read must be reported, must not keep the member
    // from becoming usable, and must leave its state (journal, owed ledger) for the
    // next start instead of turning startup into an endless poll error.
    await this.startupStep('injectBrief', () => this.injectBrief(!hadInjected));
    // §4.2: the flags on disk are the answer. Only a missing file (first start, or an
    // upgrade from the history-derived version) is reconciled — once, from history.
    // Deriving on every start is what made a debt impossible to confirm: the history can
    // only say who spoke last, so a conversation confirmed with `pg_ack` came back owed.
    if (!hadOwedFile) await this.startupStep('reconcileObligations', () => this.reconcileObligations());
    await this.startupStep('replayJournal', () => this.replayJournal());
    // §4.1: a peer that died while this member was down is still in the ledger (or in the
    // history the fallback just read). Prune it once here, at the end of startup, so
    // `idle_owed`/`pg_inspect` do not name an unanswerable conversation until the first
    // settle. The roster is read after both, so its absence is conclusive even for a debt
    // the reconciliation has only just marked.
    await this.startupStep('pruneUnanswerableDms', () => this.pruneUnanswerableDms(true));
    this.ready = true;
    // §12.5: identity is known and the platform answered whoami above. Start the repair
    // after `ready` so the normal startup path is already usable while it runs.
    this.maybeAutoRespawn();
    // The status is cosmetic: fill the ancestor path in the background, never delay ready.
    void this.refreshStatusPath();
  }

  /** Hand the current identity line to the extension. UI only; a broken consumer changes nothing here. */
  private emitStatus(): void {
    const id = this.selfId;
    if (id === undefined) return;
    const name = this.selfName === '' ? id : this.selfName;
    const path = this.statusPath.length === 0 ? [name] : this.statusPath;
    try {
      this.config.onStatus?.({ name, id, path: [...path], childCount: this.statusChildCount });
    } catch {
      // A footer renderer must never be able to break the loop.
    }
  }

  /**
   * Fill root → self and the direct-child count from `GET /v1/tree`. A failure keeps the
   * whoami fallback already emitted, so the status line degrades to the member's name.
   */
  private async refreshStatusPath(): Promise<void> {
    // No footer consumer means no reason to spend a request on UI-only data. Tests and
    // headless runs leave `onStatus` unset and keep the loop's request budget unchanged.
    if (this.config.onStatus === undefined) return;
    const self = this.selfId;
    if (self === undefined) return;
    if (this.stopped) return;
    try {
      const epoch = this.statusEpoch;
      const { nodes } = await this.pg.tree(this.stopGate.signal);
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const chain: string[] = [];
      const seen = new Set<string>();
      let cursor: string | null = self;
      while (cursor !== null && !seen.has(cursor)) {
        seen.add(cursor);
        const node = byId.get(cursor);
        if (node === undefined) break;
        chain.unshift(node.name);
        cursor = node.parent_id;
      }
      this.statusPath = chain.length === 0 ? [this.selfName === '' ? self : this.selfName] : chain;
      // A tree request started before this process spawned/removed a child must not
      // overwrite the newer local count. The path itself is stable and still useful.
      if (this.stopped) return;
      if (epoch === this.statusEpoch) {
        this.statusChildCount = nodes.filter((node) => node.parent_id === self).length;
      }
      this.emitStatus();
    } catch {
      // The fallback from whoami is still on screen; a status read is not worth a log line.
    }
  }

  /**
   * A startup courtesy: log one warning naming the step and the error, then continue.
   * The step's own files are not marked done, so a later start attempts it again.
   */
  private async startupStep(step: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      logWarn(`[pigroups] startup step ${step} failed: ${errorText(err)}; continuing`);
    }
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
      text: this.messageText(conv, brief.seq, brief.created_at, brief.sender_name, brief.body),
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
    // Platform 0.4 sends the full body under `body`; there is no `preview` shim. A
    // payload without it is a protocol error, not an empty message: report it and do
    // not inject `undefined` or '' into the model's context.
    if (typeof item.body !== 'string') {
      logWarn(
        `[pigroups] poll message ${item.to}#${item.seq} from ${item.from_name} has no body field; skipping it`,
      );
      return;
    }
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
      text: this.messageText(item.to, item.seq, item.at, item.from_name, item.body),
      kind: 'message',
      journalId,
      conv: item.to,
      seq: item.seq,
    });
  }

  /**
   * §3.3/§8.4: the one place a message body becomes injected context. The body is cut by
   * code points, and a cut body names the exact `pg_read` call that returns the rest.
   * `before=seq+1` because `/v1/messages` selects `seq < before`.
   */
  private messageText(conv: string, seq: number, at: number, fromName: string, body: string): string {
    const max = Math.max(1, Math.floor(this.config.deliveryMaxChars));
    const chars = Array.from(body);
    const stamp = formatLocalMinute(at);
    if (chars.length <= max) return `[${conv}#${seq} ${stamp}] ${fromName}: ${body}`;
    return (
      `[${conv}#${seq} ${stamp}] ${fromName}: ${chars.slice(0, max).join('')}` +
      `…[truncated: first ${max} of ${chars.length} chars; pg_read ${conv} before=${seq + 1} limit=1]`
    );
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

      case 'pg.respawn': {
        // §12.6: same trust rule as pg.abort/pg.steer; and it never enters context.
        if (!this.fromHigherUp(item)) {
          this.logIgnored(item);
          return;
        }
        const scope = typeof payload.scope === 'string' && payload.scope !== '' ? payload.scope : undefined;
        // A recursive startup control must not let a just-restored child start its
        // grandchildren before its own settle; a human `pg_respawn` tool call does
        // not go through here and stays immediate.
        const graceMs = this.config.respawnGraceMs ?? DEFAULT_RESPAWN_GRACE_MS;
        const inSettle = this.connectedAt === undefined || this.now() < this.connectedAt + graceMs;
        this.runRespawnInBackground(scope, inSettle ? { allowStart: false } : {});
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
        await this.applyAttention(payload);
        return;

      default:
        await this.injectUnknownControl(item, payload, journalId);
        return;
    }

    // A `sys.` command that did not come from `sys` is just an ordinary control.
    await this.injectUnknownControl(item, payload, journalId);
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
      // Nothing is re-delivered after a termination: the member is gone, so an
      // un-acknowledged send has nowhere to go.
      this.inFlight = undefined;
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
   * 概念稿 §8.3: the abort ends the turn and nothing else. There is no forced flush and
   * no "next batch skips the window" flag: an abort is what the queue waits behind, so
   * the work it interrupted goes out at the next turn boundary after a full window, in
   * the same tick-free order as everything else.
   */
  private async abortTurn(): Promise<void> {
    this.aborting = true;
    try {
      await this.cutTurn();
    } finally {
      this.aborting = false;
    }
  }

  /** The bounded cut itself; the caller owns the `aborting` guard. */
  private async cutTurn(): Promise<void> {
    const stop = this.stopGate.signal;
    let onStop: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cut = this.surface.abort(stop).catch((err: unknown) => {
        if (!isAbort(err)) logWarn(`[pigroups] abort failed: ${(err as Error)?.message ?? String(err)}`);
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
   * §5.1: only a direct child may change this member's view of it. Four local facts can
   * prove that relation without a request: it has reported before (telemetry), a durable
   * `children/` record names it (survives a restart), this process already reported it
   * gone, or the last roster read named its parent.
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
    // A child already reported gone is still ours, so a late queued event is silently
    // ignored by `applyAttention` instead of being injected as an unknown control.
    if (this.goneReported.has(member)) return true;
    if (this.telemetry.snapshot().some((entry) => entry.child === member)) return true;
    if (
      this.selfId !== undefined &&
      readChildRecords(this.config.adapterDir, this.selfId).some((record) => record.childId === member)
    ) {
      return true;
    }
    return this.roster?.directChildren.has(member) ?? false;
  }

  /** §3.2: an ignored state change is still information, so it leaves as a control line. */
  private async injectIgnoredNonChild(
    item: PollControlItem,
    payload: Record<string, unknown>,
    journalId?: string,
  ): Promise<void> {
    logWarn(
      `[pigroups] ignored ${item.cmd} from ${item.from_id}: the sender is not a direct child, ` +
        `so it cannot change this member's state; the control line is injected instead`,
    );
    await this.injectUnknownControl(item, payload, journalId);
  }

  private logIgnored(item: PollControlItem): void {
    logWarn(
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
   * §5.1: a deletion is an identity fact, not an attention state. Nothing is written to
   * the telemetry table here; the set only stops a queued claim from a member this
   * process already knows is deleted from describing a world that no longer exists.
   */
  private markGone(member: string): void {
    this.goneReported.add(member);
  }

  private async applyAttention(payload: Record<string, unknown>): Promise<void> {
    const child = typeof payload.child === 'string' ? payload.child : '';
    if (!child) return;
    // §5.1 (0.13.0): an older child still announces its exit as `gone`. It is no longer
    // a state; the observation that replaces it is the heartbeat (§5.4). Drop the claim
    // with one warning so the sender's version is visible, never fold it into the table.
    if (payload.state === 'gone') {
      // One line per child, like the heartbeat warnings: a child that keeps re-sending
      // the old claim must not fill the log.
      if (!this.goneAttentionWarned.has(child)) {
        this.goneAttentionWarned.add(child);
        logWarn(
          `[pigroups] dropped pg.attention state 'gone' from ${child}: gone is no longer an attention state ` +
            '(0.13.0); liveness is observed from the heartbeat, not from a message',
        );
      }
      return;
    }
    const state = attentionStateOf(payload.state);
    if (!state) return;
    // A member this process already knows is deleted cannot report anything new. Its
    // remaining events were queued before it died; folding one in would describe a world
    // that is already over.
    if (this.goneReported.has(child)) return;
    // §5.1: `since <= 0` means "now".
    const since = typeof payload.since === 'number' && payload.since > 0 ? payload.since : this.now();
    const event: AttentionEvent = {
      child,
      name: typeof payload.name === 'string' ? payload.name : child,
      state,
      since,
      of: recoverableAttentionStateOf(payload.of),
      tool: isAttentionTool(payload.tool) ? payload.tool : undefined,
      owed: Array.isArray(payload.owed) ? payload.owed.filter((c): c is string => typeof c === 'string') : undefined,
      note: typeof payload.note === 'string' ? payload.note : undefined,
      busy_ms: typeof payload.busy_ms === 'number' ? payload.busy_ms : undefined,
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
        logWarn(`[pigroups] settle reaction failed: ${(err as Error)?.message ?? String(err)}`);
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
    // The window is checked here, by the same scan the 5 s timer runs. A settle is not a
    // delivery trigger: it only ends the turn a window was waiting behind.
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
      this.blockedNotes.delete(entry.conv);
      this.silentAcks.delete(entry.conv);
      this.silentAckReported.delete(entry.conv);
      changed = true;
    }
    if (changed) {
      const now = this.now();
      await this.syncOwnState('blocked', now);
      await this.syncOwnState('silent_acking', now);
      this.evaluateAttention(now);
    }
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
    let blockedChanged = false;
    for (const entry of owed) {
      const spent = this.nudges.count(entry.conv);
      if (spent >= this.config.nudgeMax) {
        if (!this.blockedReported.has(entry.conv)) {
          this.blockedReported.add(entry.conv);
          this.blockedNotes.set(entry.conv, `no output after ${spent} nudges (${entry.conv})`);
          blockedChanged = true;
        }
        continue;
      }
      due += 1;
    }
    // §5.1: entering `blocked` (or adding a conversation to it) is an attention state
    // change, not a one-shot `pg.report`. A set that did not change is not re-sent.
    if (blockedChanged) await this.syncOwnState('blocked', this.now());
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
   * delivery window and for a turn boundary like any other item (概念稿 §8.1).
   */
  private queueReminder(now: number): void {
    const decision = this.telemetry.due(now);
    if (decision.kind !== 'remind') return;
    this.enqueue({ text: decision.text, kind: 'nudge' });
  }

  // ---- child-side telemetry: edge-triggered four states (§5.1) -----------

  private handleEvent(event: PiEvent): void {
    // A delivery echo is not a reaction to a turn: it records a message that is already in
    // the transcript, and dropping it while `stop()` waits for that very delivery would
    // leave the journal holding a batch the model has already been shown — the next start
    // would replay it. Everything else is ignored once the loop is on its way down.
    if (event.type === 'delivery_ack') {
      this.handleDeliveryAck(event.deliveryId);
      return;
    }
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
        // 概念稿 §8.3: an abort ends the turn, so the queue must not start a new one in
        // the same tick. Re-opening the window is the whole rule: whatever was waiting
        // (and, if pi never echoed it, the send that took the cut) goes out one full
        // window from here. Nothing is requeued or replayed — a send pi echoed is in the
        // transcript, and a send it did not echo is already still in `inFlight`.
        if (event.aborted === true) this.reopenWindow(now);
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
   * Start a fresh window at `now` (概念稿 §8.3). Used by the aborted turn end: the work
   * that was cut does not get to start its replacement immediately, and the queue waits
   * for a full window like any other batch.
   */
  private reopenWindow(now: number): void {
    if (!this.hasQueuedWork()) {
      this.windowStart = null;
      return;
    }
    this.windowStart = now;
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
   * The child-side running state. The parent keys its table by state name (§5.1), so
   * these four are still mutually exclusive within the child: a stalled tool is the
   * concrete fact, then a provider error, then a long turn, then owed replies while idle.
   * `blocked` and `silent_acking` live beside them in `ownStates`.
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
    const current = this.activeRun;
    if (current && current.state !== desired?.state) {
      this.activeRun = undefined;
      void this.publishAttention({ state: 'recovered', of: current.state, since: now });
    }
    if (desired === undefined) return;
    if (this.activeRun === undefined) {
      this.activeRun = { state: desired.state, since: now, extra: desired.extra };
      void this.publishAttention({ state: desired.state, since: now, ...desired.extra });
      return;
    }
    // Same state: it is still the same entry. `idle_owed` is an exception because its
    // value is a conversation set — a changed set is new information and is re-sent
    // with the original `since` (§5.1).
    const previousOwed = this.activeRun.extra.owed;
    this.activeRun.extra = desired.extra;
    if (desired.state === 'idle_owed' && !sameStrings(previousOwed, desired.extra.owed ?? [])) {
      void this.publishAttention({ state: desired.state, since: this.activeRun.since, ...desired.extra });
    }
  }

  /**
   * §5.1/§5.2: synchronise one of the child's ledger states (`blocked`,
   * `silent_acking`) with the conversations that belong to it. A set change re-sends
   * the same state with the original `since`; an empty set sends `recovered{of}`.
   */
  private async syncOwnState(state: 'blocked' | 'silent_acking', now: number): Promise<void> {
    const members = state === 'blocked' ? this.blockedReported : this.silentAckReported;
    const owed = [...members].sort();
    const prev = this.ownStates.get(state);
    if (owed.length === 0) {
      if (prev === undefined) return;
      this.ownStates.delete(state);
      await this.publishAttention({ state: 'recovered', of: state, since: now });
      return;
    }
    const note = state === 'blocked' ? this.blockedNote() : undefined;
    if (prev !== undefined && sameStrings(prev.extra.owed, owed) && prev.extra.note === note) return;
    const since = prev?.since ?? now;
    const extra: AttentionExtra = { owed, ...(note === undefined ? {} : { note }) };
    this.ownStates.set(state, { since, extra });
    await this.publishAttention({ state, since, ...extra });
  }

  private blockedNote(): string | undefined {
    const notes = [...this.blockedNotes.values()];
    return notes.length === 0 ? undefined : notes[notes.length - 1];
  }

  private publishAttention(event: Record<string, unknown>): Promise<void> {
    const parent = this.parentId;
    const self = this.selfId;
    if (!parent || !self) return Promise.resolve();
    // §8.5: every attention report carries what the last round did, so the state line
    // is never the only thing the parent has to decide with.
    return this.pg
      .sendControl({
        to: parent,
        id: randomUUID(),
        cmd: 'pg.attention',
        payload: { v: 1, child: self, name: this.selfName, ...event, last: this.lastRound() },
      })
      .then(() => undefined)
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

  /** Root-only platform ensure, off the poll path. A new URL resets startup so the next poll re-inits. */
  private async ensureRootPlatform(): Promise<void> {
    try {
      const url = await this.config.ensurePlatform?.();
      if (url !== undefined && url !== '' && url !== this.pg.url) {
        this.pg.setUrl(url);
        this.connectedAt = undefined;
        this.ready = false;
        this.readyPromise = undefined;
      }
    } catch (err) {
      logWarn(`[pigroups] root platform ensure failed: ${errorText(err)}; will retry`);
    } finally {
      this.ensureInFlight = false;
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
      // Root-only: a platform owner brings its own platform back. Children never
      // start one; they keep retrying whatever URL their record names.
      if (
        this.config.parentId === null &&
        !this.rootDemoted &&
        this.config.ensurePlatform !== undefined &&
        !this.ensureInFlight
      ) {
        this.ensureInFlight = true;
        void this.ensureRootPlatform();
      }
      await this.sleepImpl(Math.min(CONNECT_BACKOFF_MAX_MS, 1000 * 2 ** (Math.min(this.connectionFailures, 6) - 1)));
      return;
    }

    if (err instanceof PgError && err.status === 401) {
      // §9: hand the agent one line, then stop the loops and wait for a human to replace
      // the token. Not the poll's own business — a loop that is not running (no token
      // at all, §7) delivers nothing.
      //
      // The line goes through `notice`, not the delivery queue. The queue only sends at a
      // turn boundary, and a 401 regularly lands in the middle of a turn (the poll runs
      // beside the agent), so a queued line would wait for an idle moment that the
      // `stop()` right after it will never allow — the stranded notice this test exists
      // for. `notice` appends to the transcript without starting or joining a turn, so it
      // reaches the session whether or not a turn is running.
      await this.surface.notice('PIGROUPS token is no longer valid: replace it and restart this session.');
      await this.stop();
      return;
    }

    logWarn(`[pigroups] poll failed: ${(err as Error)?.message ?? String(err)}`);
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
    value === 'blocked' ||
    value === 'silent_acking' ||
    value === 'recovered'
    ? value
    : undefined;
}

/** `of:` names one of the five recoverable states; `recovered` and old `gone` do not (§6). */
function recoverableAttentionStateOf(value: unknown): RecoverableAttentionState | undefined {
  const state = attentionStateOf(value);
  return state === undefined || state === 'recovered' ? undefined : state;
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

/** Compare two conversation sets (order is not meaningful; both callers normalize). */
function sameStrings(left: string[] | undefined, right: string[] | undefined): boolean {
  const a = [...new Set(left ?? [])].sort();
  const b = [...new Set(right ?? [])].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
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

/** `kill(pid, 0)` asks "can this pid be signalled"; EPERM still means the process exists. */
function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** Keep a platform error's status/code: 401 and 429 are facts the caller must see. */
function respawnError(err: unknown): string {
  if (err instanceof PgError) return `${err.status} ${err.code}: ${err.message}`;
  return errorText(err);
}

/** The message a log line can show without inventing a shape for an unknown throw. */
function errorText(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Whether a `pane list` entry carries that label. herdr's tab label survives in the
 * terminal title as `π - <label> - <cwd>`; splitting on the spaced separators keeps
 * `runner` from matching `runner-2`.
 */
function paneMatchesName(pane: HerdrPane, name: string): boolean {
  if (pane.label === name || pane.title === name) return true;
  if (pane.title === undefined) return false;
  return pane.title
    .split(/\s+[-\u2013\u2014\u00b7|:]\s+/)
    .map((part) => part.trim())
    .some((part) => part === name);
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
