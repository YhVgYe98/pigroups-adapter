/**
 * Local tables that make the adapter's two obligations and its telemetry work.
 * Pure logic, no HTTP: 设计说明 §4 (欠回复) and §5 (遥测).
 *
 * The owed reply itself is not here: it is a persisted flag (`OwedLedger`, `owed.ts`),
 * because a debt that only exists between polls cannot be confirmed. What stays in
 * memory is the nudge budget: "how many times have I already asked" is about this
 * process's conversation with the model, not about the ledger.
 */

/**
 * §4.3: how many reminders a still-owed conversation has spent, per conversation. It
 * survives an inbound message and a `pg_ack`; only the member speaking (`say`) ends the
 * episode and resets it.
 */
export class NudgeBudget {
  private readonly spent = new Map<string, number>();

  count(conv: string): number {
    return this.spent.get(conv) ?? 0;
  }

  /** Count one delivered nudge. Returns the new total. */
  record(conv: string): number {
    const total = this.count(conv) + 1;
    this.spent.set(conv, total);
    return total;
  }

  /** The member spoke: the episode is over and the next debt starts with a full budget. */
  clear(conv: string): void {
    this.spent.delete(conv);
  }
}

export type AttentionState =
  | 'stalled'
  | 'slow_turn'
  | 'error'
  | 'idle_owed'
  | 'blocked'
  | 'silent_acking'
  | 'recovered'
  | 'gone';

/** The six states a `recovered{of}` may name. `gone` is terminal and never in `of`. */
export type RecoverableAttentionState = Exclude<AttentionState, 'recovered' | 'gone'>;

export interface AttentionTool {
  name: string;
  elapsed_ms: number;
  preview: string;
}

/** The last tool call a member finished: what it ran and whether pi called it ok. */
export interface LastTool {
  name: string;
  /** The 200-character argument preview (the same one `tool_start` carries). */
  preview: string;
  /**
   * pi's `isError` inverted. Not proof of success: a tool cut short by an abort can
   * end with `isError: false` (概念稿 §9 D4), which is why the report carries the
   * values rather than a verdict.
   */
  ok: boolean;
}

/**
 * What a member's last round was doing (概念稿 §8.5): the last assistant text and the
 * last finished tool call. This is what makes `pg_abort`/`pg_inspect` something other
 * than a blind operation for the parent.
 */
export interface LastRound {
  text?: string;
  tool?: LastTool;
}

/** A `pg.attention` payload (设计说明 §6). */
export interface AttentionEvent {
  child: string;
  name: string;
  state: AttentionState;
  since: number;
  of?: RecoverableAttentionState;
  tool?: AttentionTool;
  owed?: string[];
  note?: string;
  busy_ms?: number;
  last?: LastRound;
}

/** One state in a child's activity table (§5.1). */
export interface StateSnapshot {
  state: AttentionState;
  since: number;
  tool?: AttentionTool;
  owed?: string[];
  note?: string;
  busy_ms?: number;
  /** Events folded into this state entry since it was entered. */
  count: number;
  /** When this state entry was reminded; `null` means never. */
  remindedAt: number | null;
}

export interface TelemetryEntry {
  child: string;
  name: string;
  /**
   * The state of the latest accepted event. The full picture is `states`; this field
   * stays for callers that only need "what did this child say most recently".
   */
  state: AttentionState;
  /** `since` of the latest state entry. */
  stateSince: number;
  tool?: AttentionTool;
  owed?: string[];
  note?: string;
  busy_ms?: number;
  last?: LastRound;
  /** Events folded into this child since its first report. */
  count: number;
  remindedAt: number | null;
  /** Every state the child is in, in the order each was first entered (§5.1). */
  states: StateSnapshot[];
}

export type TelemetryDecision =
  | { kind: 'idle' }
  | { kind: 'silent' }
  | { kind: 'remind'; text: string; children: string[] };

export interface TelemetryOptions {
  /** Coalescing window opened by the first unhandled event (§5.2). */
  windowMs: number;
}

/** A state whose value is a set of conversations (§5.1). A set change is new information. */
const SET_STATES = new Set<AttentionState>(['idle_owed', 'blocked', 'silent_acking']);

interface StateRow extends StateSnapshot {}
interface ChildRow {
  child: string;
  name: string;
  states: Map<AttentionState, StateRow>;
  lastState: AttentionState;
  last?: LastRound;
  count: number;
}

/**
 * Parent side of telemetry (§5.2): `child → {state → {since, tool, owed, note}}`, plus
 * the coalescing window. The key of the inner table is the state name, not
 * `(state, conversation)`: a state has one `since` (when it was entered), and the
 * conversations are part of its value. One child can be `error` and `blocked` at once.
 *
 * Nothing here is injected by itself; the loop decides whether the member is idle
 * enough to receive a reminder.
 */
export class TelemetryTable {
  private readonly entries = new Map<string, ChildRow>();
  private readonly windowMs: number;
  private windowStart: number | null = null;

  constructor(opts: TelemetryOptions) {
    this.windowMs = opts.windowMs;
  }

  /** Fold one `pg.attention` event into the table. Never injects. */
  apply(event: AttentionEvent, now: number): void {
    if (event.state === 'recovered') {
      const child = this.entries.get(event.child);
      const of = event.of;
      // §5.1: `gone` is terminal and not an `of:` value; the parser has already
      // rejected it, so an absent `of` is the only shape left to refuse.
      if (child === undefined || of === undefined) return;
      if (child.states.has('gone') || !child.states.delete(of)) return;
      if (child.states.size === 0) this.entries.delete(event.child);
      return;
    }

    let child = this.entries.get(event.child);
    // A member that reported `gone` cannot come back with another state. Its remaining
    // events were queued before it died; folding one in would erase the terminal fact.
    if (child?.states.has('gone')) return;

    if (child === undefined) {
      child = {
        child: event.child,
        name: event.name,
        states: new Map(),
        lastState: event.state,
        count: 0,
      };
      this.entries.set(event.child, child);
    }
    child.name = event.name;

    const prev = child.states.get(event.state);
    const setState = SET_STATES.has(event.state);
    const owed = setState ? normalizeOwed(event.owed ?? prev?.owed) : (event.owed ?? prev?.owed);
    // §5.1: a set change is a new event for the same state entry. A repeated event with
    // the same set is not; it only refreshes the fields and the count.
    const changed = prev === undefined || (setState && !sameOwed(prev.owed, owed));
    const row: StateRow = {
      state: event.state,
      // §5.1: the table key is the state name, so collection changes never reset `since`.
      since: prev?.since ?? (event.since || now),
      tool: event.tool ?? prev?.tool,
      owed,
      note: event.note ?? prev?.note,
      busy_ms: event.busy_ms ?? prev?.busy_ms,
      count: (prev?.count ?? 0) + 1,
      // One reminder per state entry. Re-arming on a repeated event is what used to
      // replay a frozen snapshot for 6.5 hours (§5.2); a real re-entry or a set change
      // is new information and does re-arm.
      remindedAt: changed ? null : (prev?.remindedAt ?? null),
    };
    child.states.set(event.state, row);
    child.lastState = event.state;
    child.count += 1;
    if (event.last !== undefined) child.last = event.last;

    // §5.2: `idle_owed` never opens the window. It is reported — `pg_children` reads it —
    // but a debt in a conversation the parent may not be part of is not something the
    // parent can act on, so it must not cost it a whole context request.
    if (changed && event.state !== 'idle_owed') this.openWindow(now);
  }

  snapshot(): TelemetryEntry[] {
    return [...this.entries.values()].map((child) => {
      const row = child.states.get(child.lastState);
      return {
        child: child.child,
        name: child.name,
        state: child.lastState,
        stateSince: row?.since ?? 0,
        tool: row?.tool,
        owed: row?.owed,
        note: row?.note,
        busy_ms: row?.busy_ms,
        last: child.last,
        count: child.count,
        remindedAt: row?.remindedAt ?? null,
        states: [...child.states.values()].map((state) => ({ ...state })),
      };
    });
  }

  /**
   * What the parent should do right now.
   *
   * - `idle`: nothing to say (no event, window still open, or already reminded).
   * - `silent`: the table emptied without anything left to report; cancel without a
   *   trace (§5.2).
   * - `remind`: deliver the rolled-up text as a `nudge`.
   *
   * The caller is `tick()`: the rolled-up text is queued like any other item and
   * leaves with the next delivery window (概念稿 §8.1).
   */
  due(now: number): TelemetryDecision {
    if (this.entries.size === 0) {
      this.windowStart = null;
      return { kind: 'silent' };
    }

    const urgent = [...this.entries.values()].some(
      (child) => child.states.get('gone')?.remindedAt === null,
    );
    const expired = this.windowStart !== null && now - this.windowStart >= this.windowMs;
    if (!urgent && !expired) return { kind: 'idle' };

    // §5.2: a summary never contains `idle_owed`, either alone or beside something the
    // parent can act on. `blocked` and `silent_acking` do belong here.
    const reportable: Array<{ child: ChildRow; states: StateRow[] }> = [];
    for (const child of this.entries.values()) {
      const states = [...child.states.values()].filter((state) => state.state !== 'idle_owed');
      if (states.length === 0) continue;
      if (!states.some((state) => state.remindedAt === null)) continue;
      reportable.push({ child, states });
    }
    if (reportable.length === 0) {
      this.windowStart = now;
      return { kind: 'idle' };
    }

    for (const line of reportable) {
      for (const state of line.states) state.remindedAt = now;
    }
    for (const line of reportable) {
      // §5.2: `gone` is terminal and reported once; the whole child row goes with it.
      if (line.states.some((state) => state.state === 'gone')) this.entries.delete(line.child.child);
    }
    this.windowStart = this.entries.size > 0 ? now : null;

    return {
      kind: 'remind',
      text: renderAttention(reportable, now),
      children: reportable.map((line) => line.child.child),
    };
  }

  private openWindow(now: number): void {
    if (this.windowStart === null) this.windowStart = now;
  }
}

function normalizeOwed(owed: string[] | undefined): string[] {
  return [...new Set(owed ?? [])].sort();
}

function sameOwed(left: string[] | undefined, right: string[] | undefined): boolean {
  const a = normalizeOwed(left);
  const b = normalizeOwed(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * §5.2: what the parent is told. English on purpose (P7): this is a prompt for a model,
 * not a report for a person. One child is one line; all of its summarizable states are
 * on that line.
 *
 *     2 children need attention:
 *     - m_abc (reviewer) stalled 12m in bash: find ~/ -name '*.ts'
 *     - m_def (coder) error: provider 429 x7; blocked (2 convs: dm:m_a_m_d, dm:m_b_m_d)
 */
function renderAttention(entries: Array<{ child: ChildRow; states: StateRow[] }>, now: number): string {
  const header = entries.length === 1 ? '1 child needs attention:' : `${entries.length} children need attention:`;
  const lines = [header];
  for (const entry of entries) {
    const states = entry.states.map((state) => renderState(state, now)).join('; ');
    lines.push(`- ${entry.child.child} (${entry.child.name}) ${states}${renderLast(entry.child.last)}`);
  }
  return lines.join('\n');
}

/** The last round, appended to the child's line so the parent reads one row per child (§8.4). */
function renderLast(last: LastRound | undefined): string {
  if (!last) return '';
  const parts: string[] = [];
  if (last.text !== undefined) parts.push(`said: ${last.text}`);
  if (last.tool !== undefined) {
    const verdict = last.tool.ok ? '' : ' (failed)';
    const preview = last.tool.preview === '' ? '' : `: ${last.tool.preview}`;
    parts.push(`last tool ${last.tool.name}${preview}${verdict}`);
  }
  return parts.length === 0 ? '' : `; last round ${parts.join(', ')}`;
}

function renderState(entry: StateRow, now: number): string {
  const elapsed = formatDuration(now - entry.since);
  switch (entry.state) {
    case 'stalled': {
      const tool = entry.tool ? ` in ${entry.tool.name}: ${entry.tool.preview}` : '';
      return `stalled ${elapsed}${tool}`;
    }
    case 'slow_turn':
      return `slow_turn ${elapsed}`;
    case 'error':
      return `error: ${entry.note ?? 'provider error'}`;
    case 'idle_owed':
      return `idle_owed ${elapsed}${entry.owed?.length ? `, owed: ${entry.owed.join(', ')}` : ''}`;
    case 'blocked':
      return `blocked${renderConvSet(entry.owed)}`;
    case 'silent_acking':
      return `silent_acking${renderConvSet(entry.owed)}`;
    case 'recovered':
      return 'recovered';
    case 'gone':
      return `gone${entry.note ? `: ${entry.note}` : ''}`;
  }
}

function renderConvSet(owed: string[] | undefined): string {
  if (owed === undefined || owed.length === 0) return '';
  const noun = owed.length === 1 ? 'conv' : 'convs';
  return ` (${owed.length} ${noun}: ${owed.join(', ')})`;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}
