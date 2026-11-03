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
  /**
   * When this state entry was reminded to the member; `null` means never. §5.2 reminds
   * a state entry exactly once — a long-lived state is not a reason to speak again.
   */
  remindedAt: number | null;
}

export type TelemetryDecision =
  | { kind: 'idle' }
  | { kind: 'silent' }
  | { kind: 'remind'; text: string; children: string[] };

export interface TelemetryOptions {
  /** Coalescing window opened by the first unhandled event (§5.2). */
  windowMs: number;
}

/**
 * Parent side of telemetry (§5.2): `child → {state, since, tool, count}`, plus
 * the coalescing window. Nothing here is injected by itself; the loop decides
 * whether the member is idle enough to receive a reminder.
 */
export class TelemetryTable {
  private readonly entries = new Map<string, TelemetryEntry>();
  private readonly windowMs: number;
  private windowStart: number | null = null;

  constructor(opts: TelemetryOptions) {
    this.windowMs = opts.windowMs;
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
      // (a) entering a state is what may be reminded, and only once (§5.2). A second
      // event for the same state is the same entry, not a new one: re-arming here is
      // what used to turn a frozen child into a repeating reminder.
      remindedAt: stateChanged ? null : prev.remindedAt,
    });
    // §5.2: `idle_owed` never opens the window. It is reported — `pg_children` reads it —
    // but a debt in a conversation the parent may not be part of is not something the
    // parent can act on, so it must not cost it a whole context request.
    if (this.windowStart === null && event.state !== 'idle_owed') this.windowStart = now;
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
      (entry) => entry.state === 'gone' && entry.remindedAt === null,
    );
    const expired = now - this.windowStart >= this.windowMs;
    if (!urgent && !expired) return { kind: 'idle' };

    const reportable = [...this.entries.values()].filter(
      // §5.2: a summary must never be made of `idle_owed` alone (or carry it along):
      // it reports a state, it never asks the parent for anything.
      (entry) => entry.state !== 'recovered' && entry.state !== 'idle_owed' && entry.remindedAt === null,
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
}

/**
 * §5.2: what the parent is told. English on purpose (P7): this is a prompt for a model,
 * not a report for a person. The shape is the one the design pins:
 *
 *     2 children need attention:
 *     - m_abc (reviewer) stalled 12m in bash: find ~/ -name '*.ts'
 */
function renderAttention(entries: TelemetryEntry[], now: number): string {
  const header = entries.length === 1 ? '1 child needs attention:' : `${entries.length} children need attention:`;
  const lines = [header];
  for (const entry of entries) lines.push(`- ${entry.child} (${entry.name}) ${renderState(entry, now)}${renderLast(entry)}`);
  return lines.join('\n');
}

/** The last round, appended to the state line so the parent reads one row per child (§8.4). */
function renderLast(entry: TelemetryEntry): string {
  const last = entry.last;
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

function renderState(entry: TelemetryEntry, now: number): string {
  const elapsed = formatDuration(now - entry.stateSince);
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
    case 'recovered':
      return `recovered${entry.of ? ` (was ${entry.of})` : ''}`;
    case 'gone':
      return `gone${entry.note ? `: ${entry.note}` : ''}`;
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
