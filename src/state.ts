/**
 * Local tables that make the adapter's two obligations and its telemetry work.
 * Pure logic, no HTTP: 设计说明 §4 (欠回复) and §5 (遥测).
 */

export interface Obligation {
  conv: string;
  /** Seq of the last message in the conversation that is not mine. */
  lastSeq: number;
  /** When the conversation first became owed (for the `idle_owed` state, §5.1). */
  since: number;
  nudges: number;
}

/**
 * Owed replies (§4). The truth is recomputed from conversation history on every
 * start (§4.1); this table only mirrors it between polls, so a restart needs no
 * local state.
 */
export class ObligationTable {
  private readonly owed = new Map<string, Obligation>();

  /** Mark a conversation owed. Idempotent; keeps the original `since`. */
  mark(conv: string, lastSeq: number, now: number): void {
    const existing = this.owed.get(conv);
    if (existing) {
      existing.lastSeq = Math.max(existing.lastSeq, lastSeq);
      return;
    }
    this.owed.set(conv, { conv, lastSeq, since: now, nudges: 0 });
  }

  /** The conversation stopped being owed: the member spoke, or the history moved on. */
  clear(conv: string): void {
    this.owed.delete(conv);
  }

  entries(): Obligation[] {
    return [...this.owed.values()];
  }

  /** One nudge per conversation per settle (§4.3). Returns the new nudge total. */
  recordNudge(conv: string): number {
    const entry = this.owed.get(conv);
    if (!entry) return 0;
    entry.nudges += 1;
    return entry.nudges;
  }

  /** Conversations owed for longer than `ms` while idle → the `idle_owed` state. */
  owedLongerThan(ms: number, now: number): Obligation[] {
    return this.entries().filter((entry) => now - entry.since >= ms);
  }
}

export type AttentionState = 'stalled' | 'slow_turn' | 'error' | 'idle_owed' | 'recovered' | 'gone';

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
  of?: AttentionState;
  tool?: AttentionTool;
  owed?: string[];
  note?: string;
  last?: LastRound;
}

export interface TelemetryEntry {
  child: string;
  name: string;
  state: AttentionState;
  /** State entry time, as sent by the child. */
  stateSince: number;
  /** For `recovered`: the state that was left. */
  of?: AttentionState;
  tool?: AttentionTool;
  owed?: string[];
  note?: string;
  /** The last round the child reported (概念稿 §8.5). */
  last?: LastRound;
  /** Events folded into this entry since the last reminder. */
  count: number;
  /** When this state was last reminded to the member; `null` means never. */
  remindedAt: number | null;
}

export type TelemetryDecision =
  | { kind: 'idle' }
  | { kind: 'silent' }
  | { kind: 'remind'; text: string; children: string[] };

export interface TelemetryOptions {
  /** Coalescing window opened by the first unhandled event (§5.2). */
  windowMs: number;
  /** A state that keeps going this long is reminded again. */
  repeatAfterMs?: number;
}

const DEFAULT_REPEAT_AFTER_MS = 1_800_000;

/**
 * Parent side of telemetry (§5.2): `child → {state, since, tool, count}`, plus
 * the coalescing window. Nothing here is injected by itself; the loop decides
 * whether the member is idle enough to receive a reminder.
 */
export class TelemetryTable {
  private readonly entries = new Map<string, TelemetryEntry>();
  private readonly windowMs: number;
  private readonly repeatAfterMs: number;
  private windowStart: number | null = null;

  constructor(opts: TelemetryOptions) {
    this.windowMs = opts.windowMs;
    this.repeatAfterMs = opts.repeatAfterMs ?? DEFAULT_REPEAT_AFTER_MS;
  }

  /** Fold one `pg.attention` event into the table. Never injects. */
  apply(event: AttentionEvent, now: number): void {
    const prev = this.entries.get(event.child);
    const stateChanged = prev === undefined || prev.state !== event.state;
    this.entries.set(event.child, {
      child: event.child,
      name: event.name,
      state: event.state,
      stateSince: stateChanged ? (event.since || now) : prev.stateSince,
      of: event.of,
      tool: event.tool,
      owed: event.owed,
      note: event.note,
      last: event.last,
      count: (prev?.count ?? 0) + 1,
      // (a) once a new event arrives, this child may be reminded again.
      remindedAt: null,
    });
    if (this.windowStart === null) this.windowStart = now;
  }

  snapshot(): TelemetryEntry[] {
    return [...this.entries.values()];
  }

  /**
   * What the parent should do right now.
   *
   * - `idle`: nothing to say (no event, window still open, or already reminded).
   * - `silent`: the window expired and every child recovered — cancel without a
   *   trace (§5.2).
   * - `remind`: deliver the rolled-up text as a `nudge`.
   *
   * The caller is `tick()`: the rolled-up text is queued like any other item and
   * leaves with the next delivery window (概念稿 §8.1). A busy member is a normal
   * recipient now — delivery is a steer — so idleness is not a gate here.
   */
  due(now: number): TelemetryDecision {
    if (this.entries.size === 0) {
      this.windowStart = null;
      return { kind: 'idle' };
    }

    if ([...this.entries.values()].every((entry) => entry.state === 'recovered')) {
      this.entries.clear();
      this.windowStart = null;
      return { kind: 'silent' };
    }

    if (this.windowStart === null) return { kind: 'idle' };

    const urgent = [...this.entries.values()].some(
      (entry) => entry.state === 'gone' && this.shouldReport(entry, now),
    );
    const expired = now - this.windowStart >= this.windowMs;
    if (!urgent && !expired) return { kind: 'idle' };

    const reportable = [...this.entries.values()].filter(
      (entry) => entry.state !== 'recovered' && this.shouldReport(entry, now),
    );
    if (reportable.length === 0) {
      this.windowStart = now;
      return { kind: 'idle' };
    }

    for (const entry of reportable) entry.remindedAt = now;
    for (const entry of [...this.entries.values()]) {
      // `recovered` is never reported and `gone` is terminal: both are done after
      // they have been folded into a reminder.
      if (entry.state === 'recovered' || entry.state === 'gone') this.entries.delete(entry.child);
    }
    this.windowStart = now;

    return {
      kind: 'remind',
      text: renderAttention(reportable, now),
      children: reportable.map((entry) => entry.child),
    };
  }

  private shouldReport(entry: TelemetryEntry, now: number): boolean {
    if (entry.remindedAt === null) return true;
    return (
      now - entry.stateSince >= this.repeatAfterMs && now - entry.remindedAt >= this.repeatAfterMs
    );
  }
}

function renderAttention(entries: TelemetryEntry[], now: number): string {
  const lines = [`你的 ${entries.length} 个下级需要处理：`];
  for (const entry of entries) lines.push(`- ${entry.child}（${entry.name}）${renderState(entry, now)}${renderLast(entry)}`);
  return lines.join('\n');
}

/** The last round, appended to the state line so the parent reads one row per child (§8.4). */
function renderLast(entry: TelemetryEntry): string {
  const last = entry.last;
  if (!last) return '';
  const parts: string[] = [];
  if (last.text !== undefined) parts.push(`说：${last.text}`);
  if (last.tool !== undefined) {
    const verdict = last.tool.ok ? '' : '（失败）';
    const preview = last.tool.preview === '' ? '' : `：${last.tool.preview}`;
    parts.push(`最后工具 ${last.tool.name}${preview}${verdict}`);
  }
  return parts.length === 0 ? '' : `；最后一轮${parts.join('，')}`;
}

function renderState(entry: TelemetryEntry, now: number): string {
  const elapsed = formatDuration(now - entry.stateSince);
  switch (entry.state) {
    case 'stalled': {
      const tool = entry.tool ? ` 在 ${entry.tool.name}：${entry.tool.preview}` : '';
      return `stalled ${elapsed}${tool}`;
    }
    case 'slow_turn':
      return `slow_turn ${elapsed}`;
    case 'error':
      return `error：${entry.note ?? 'provider error'}`;
    case 'idle_owed':
      return `idle_owed ${elapsed}${entry.owed?.length ? `，欠回复：${entry.owed.join(', ')}` : ''}`;
    case 'recovered':
      return `recovered${entry.of ? `（原 ${entry.of}）` : ''}`;
    case 'gone':
      return `gone${entry.note ? `：${entry.note}` : ''}`;
  }
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
