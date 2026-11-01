/**
 * `PiSurface`: everything the loop is allowed to know about Pi (设计说明 §2.1).
 * The real implementation lives here too; `loop.ts` imports only the interface.
 *
 * The pi side is described structurally instead of importing
 * `@earendil-works/pi-coding-agent`: this repo has no build step and no pi
 * dependency, so the types below mirror the parts of
 * `pi-coding-agent@1.4.0` (`dist/core/extensions/types.d.ts`) that are used.
 */

export type DeliverKind = 'message' | 'control' | 'nudge' | 'digest';

/** The only observability channel the loop has (设计说明 §2.1). */
export type PiEvent =
  | { type: 'turn_start' }
  | { type: 'turn_end'; error?: { message: string } }
  | { type: 'tool_start'; name: string; argsPreview: string }
  | { type: 'tool_end'; name: string; ok: boolean };

export interface PiSurface {
  /**
   * Hand a block of text to the agent as one turn. Resolves once pi has accepted the
   * message, not when a run has started: `pi.sendMessage` is void and swallows start
   * errors, so a run that fails to start is invisible from here (设计说明 §2.1).
   */
  deliver(text: string, kind: DeliverKind): Promise<void>;
  /**
   * Cut the running turn and wait until idle. Returns at once when already idle.
   * The wait is bounded by `ABORT_IDLE_TIMEOUT_MS` and giving up leaves the abort
   * request standing; `signal` ends the wait early, which is how `stop()` cuts it.
   */
  abort(signal?: AbortSignal): Promise<void>;
  /** Is a turn running right now. */
  isBusy(): boolean;
  /** Call back when idle. Returns an unsubscribe function. */
  onSettled(cb: () => void): () => void;
  /** Raw event stream: the only observability channel (必需成员, §2.1). */
  onEvent(cb: (event: PiEvent) => void): () => void;
  /** Orderly process exit. */
  shutdown(reason: string): void;
}

/** The message shape `pi.sendMessage` takes (a `CustomMessage` pick). */
export interface PiMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
}

/** The context members this adapter touches (`ExtensionContext` in pi). */
export interface PiContext {
  isIdle(): boolean;
  abort(): void;
  shutdown(): void;
}

/**
 * Structural view of the pi `ExtensionAPI`. `on` is declared per event so the
 * payloads here are readable; the real object satisfies them at runtime.
 */
export interface PiLike {
  sendMessage(message: PiMessage, options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' }): void;
  registerTool(tool: PiToolDefinition): void;
  on(event: 'agent_start', handler: () => void): () => void;
  on(
    event: 'tool_execution_start',
    handler: (event: { toolName: string; args: unknown }) => void,
  ): () => void;
  on(
    event: 'tool_execution_end',
    handler: (event: { toolName: string; isError: boolean }) => void,
  ): () => void;
  on(
    event: 'agent_before_settle',
    handler: (event: { outcome: 'completed' | 'aborted' | 'error' }) => void,
  ): () => void;
  on(event: 'agent_settled', handler: (event: { aborted: boolean }) => void): () => void;
  on(event: 'session_start', handler: (event: { reason: string }, ctx: PiContext) => void): () => void;
  on(event: 'session_shutdown', handler: (event: { reason: string }) => void): () => void;
}

/** The parts of `ToolDefinition` this adapter fills in. */
export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: PiContext,
  ): Promise<{ content: { type: 'text'; text: string }[]; details?: unknown }>;
}

export const PIGROUPS_CUSTOM_TYPE = 'pigroups';

const ARGS_PREVIEW_CHARS = 200;
const IDLE_POLL_MS = 50;

/**
 * How long `abort()` waits for the turn to stop (§3.2). A control item is handled
 * serially, so an unbounded wait would hold the loop for a whole turn — the next
 * `pg.abort`, a `pg.steer` or `sys.terminated` would sit behind it.
 */
export const ABORT_IDLE_TIMEOUT_MS = 3000;

export interface PiSurfaceOptions {
  /** Bound on the idle wait in `abort()`; tests shrink it so the give-up path is reachable. */
  abortIdleTimeoutMs?: number;
  /** How often `abort()` samples `ctx.isIdle()`. */
  idlePollMs?: number;
}

/**
 * The real `PiSurface`. It is the whole of the pi-specific glue:
 * `pi.sendMessage(..., {triggerTurn:true})` to deliver, the session abort to cut
 * a turn, `ctx.shutdown()` to exit, and five pi events mapped onto `PiEvent`.
 */
export class PiSurfaceAdapter implements PiSurface {
  private readonly pi: PiLike;
  private readonly settleListeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: PiEvent) => void>();
  private readonly abortIdleTimeoutMs: number;
  private readonly idlePollMs: number;
  private context: PiContext | undefined;
  /** Whether `agent_start` opened a turn that `agent_before_settle` has not closed. */
  private turnOpen = false;

  constructor(pi: PiLike, opts: PiSurfaceOptions = {}) {
    this.pi = pi;
    this.abortIdleTimeoutMs = opts.abortIdleTimeoutMs ?? ABORT_IDLE_TIMEOUT_MS;
    this.idlePollMs = opts.idlePollMs ?? IDLE_POLL_MS;

    // pi event → PiEvent (设计说明 §2.1). `agent_before_settle` carries the run
    // outcome and is the normal turn_end source; `agent_settled` closes the turn when
    // the run was aborted, because that path skips before_settle entirely.
    pi.on('agent_start', () => {
      this.turnOpen = true;
      this.publish({ type: 'turn_start' });
    });
    pi.on('tool_execution_start', (event) =>
      this.publish({ type: 'tool_start', name: event.toolName, argsPreview: previewArgs(event.args) }),
    );
    pi.on('tool_execution_end', (event) =>
      this.publish({ type: 'tool_end', name: event.toolName, ok: !event.isError }),
    );
    pi.on('agent_before_settle', (event) => {
      this.turnOpen = false;
      this.publish({
        type: 'turn_end',
        error: event.outcome === 'completed' ? undefined : { message: `turn ended: ${event.outcome}` },
      });
    });
    pi.on('agent_settled', (event) => {
      // An aborted run never reaches `agent_before_settle`: pi breaks out of the run
      // before the settle boundary, so the handler above never fires. Verified on a
      // live session (probe/, 2026-11-01): abort inside a running tool produced
      // `assistant_end stopReason=error` then `agent_settled aborted=true`, and no
      // before_settle at all. Without this line the loop keeps the turn open forever
      // after a `pg.abort` and the parent never hears that the turn was cut.
      //
      // `turnOpen` keeps a *normal* close from being followed by a second turn_end:
      // an abort can land in another extension's async boundary after before_settle,
      // and pi then reports the settled run as aborted. Only a turn that no
      // before_settle closed is ours to close here.
      if (event.aborted && this.turnOpen) {
        this.turnOpen = false;
        this.publish({ type: 'turn_end', error: { message: 'turn ended: aborted' } });
      }
      for (const listener of this.settleListeners) listener();
    });
  }

  /** The session context arrives on `session_start`; before that nothing is deliverable. */
  attachContext(ctx: PiContext): void {
    this.context = ctx;
  }

  async deliver(text: string, kind: DeliverKind): Promise<void> {
    // Fire-and-forget by pi's contract: `sendMessage` returns void and pi swallows a
    // start failure. The loop may not treat this return as "a run is now going".
    this.pi.sendMessage(
      { customType: PIGROUPS_CUSTOM_TYPE, content: text, display: true, details: { kind } },
      { triggerTurn: true },
    );
  }

  async abort(signal?: AbortSignal): Promise<void> {
    const ctx = this.context;
    if (!ctx || ctx.isIdle()) return;
    ctx.abort();
    // Polling `isIdle` is the only way pi reports "that turn is over". Giving up is
    // not an error: the abort is requested, the turn is still running, and the
    // settle that eventually arrives delivers whatever is held.
    const deadlineAt = Date.now() + this.abortIdleTimeoutMs;
    while (!ctx.isIdle()) {
      if (signal?.aborted) return;
      if (Date.now() >= deadlineAt) {
        // Giving up is allowed (§3.2) but must not be silent: staying busy past the
        // bound is exactly the failure `pg.abort` exists to prevent, and a silent
        // return makes it look like the cut succeeded.
        console.warn(
          `[pigroups] abort() gave up after ${this.abortIdleTimeoutMs} ms: the turn is still running; the abort request stands`,
        );
        return;
      }
      await sleep(this.idlePollMs);
    }
  }

  isBusy(): boolean {
    return this.context ? !this.context.isIdle() : false;
  }

  onSettled(cb: () => void): () => void {
    this.settleListeners.add(cb);
    return () => this.settleListeners.delete(cb);
  }

  onEvent(cb: (event: PiEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  shutdown(_reason: string): void {
    this.context?.shutdown();
  }

  private publish(event: PiEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }
}

function previewArgs(args: unknown): string {
  const text = typeof args === 'string' ? args : safeJson(args);
  return text.length > ARGS_PREVIEW_CHARS ? `${text.slice(0, ARGS_PREVIEW_CHARS)}…` : text;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
