/**
 * `PiSurface`: everything the loop is allowed to know about Pi (设计说明 §2.1).
 * The real implementation lives here too; `loop.ts` imports only the interface.
 *
 * The pi side is described structurally instead of importing
 * `@earendil-works/pi-coding-agent`: this repo has no build step and no pi
 * dependency, so the types below mirror the parts of
 * `pi-coding-agent@1.4.0` (`dist/core/extensions/types.d.ts`) that are used.
 */

import { logWarn } from './log.ts';

export type DeliverKind = 'message' | 'control' | 'nudge' | 'digest' | 'scheduled';

/** The only observability channel the loop has (设计说明 §2.1). */
export type PiEvent =
  | { type: 'turn_start' }
  /**
   * `aborted` is the one turn end the delivery layer must act on: an abort ends the
   * turn, so the queue must not start a new one in the same tick (概念稿 §8.3).
   */
  | { type: 'turn_end'; error?: { message: string }; aborted?: true }
  | { type: 'tool_start'; name: string; argsPreview: string }
  | { type: 'tool_end'; name: string; ok: boolean }
  /**
   * pi echoed the custom message whose `details.deliveryId` is this id: it is now in
   * the session (`message_end`), which is the only proof the loop can get that the
   * batch is in the transcript rather than lost in a run that never started
   * (概念稿 §8.1, 设计说明 §3.4).
   */
  | { type: 'delivery_ack'; deliveryId: string };

/**
 * Hand a block of text to the agent. Resolves once pi has accepted the call, not when
 * the message is in the transcript: `pi.sendMessage` is void and swallows start errors,
 * so a run that fails to prepare is invisible here (设计说明 §2.1). The message is
 * committed when the matching `delivery_ack` arrives; `deliveryId` is what lets the loop
 * tell its own messages apart on pi's `message_end`.
 *
 * The loop may not call this while `isBusy()`: one `sendMessage` with `triggerTurn`
 * starts a turn, and a message handed over during a turn is steered into it — the one
 * path measured to lose a message when an abort lands (概念稿 §8.3).
 */
export interface PiSurface {
  deliver(text: string, kind: DeliverKind, deliveryId: string): Promise<void>;
  /**
   * Append a one-line notice to the session without starting or joining a turn: pi
   * queues it for the end of the running one. Used for the token line of §9, which must
   * survive the idle gate because the loop stops right after it.
   */
  notice(text: string): Promise<void>;
  /**
   * Cut the running turn and wait until idle. Returns at once when already idle.
   * The wait is bounded by `ABORT_IDLE_TIMEOUT_MS` and giving up leaves the abort
   * request standing; `signal` ends the wait early, which is how `stop()` cuts it.
   */
  abort(signal?: AbortSignal): Promise<void>;
  /**
   * Is a turn running right now. With no session context attached this answers `true`: an
   * unknown state must never open the idle gate (概念稿 §8.1).
   */
  isBusy(): boolean;
  /**
   * The last assistant text this session produced, or `undefined` before the first
   * one. Kept by the surface from pi's `message_end` (概念稿 §8.5): the parent reads
   * it through `pg.attention` / `pg.inspect_result` to see what a child last said.
   */
  lastAssistantText(): string | undefined;
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

/** The one read-only session-manager member this adapter uses (`ReadonlySessionManager` in pi). */
export interface PiSessionManager {
  getSessionFile(): string | undefined;
}

/** The context members this adapter touches (`ExtensionContext` in pi). */
export interface PiContext {
  isIdle(): boolean;
  abort(): void;
  shutdown(): void;
  /** pi supplies this on `session_start`; optional because older fakes and versions do not. */
  sessionManager?: PiSessionManager;
  /**
   * TUI surface; absent in older fakes/versions. The status is one line in the footer and
   * never enters model context.
   */
  ui?: {
    setStatus(key: string, text: string | undefined): void;
    theme?: { bold(text: string): string };
  };
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
  /** Carries every finished message; only assistant messages are kept (概念稿 §8.5). */
  on(event: 'message_end', handler: (event: { message: unknown }) => void): () => void;
  on(event: 'session_start', handler: (event: { reason: string }, ctx: PiContext) => void): () => void;
  /**
   * Navigation in the session tree. Every jump invalidates the context captured at
   * `session_start`; the handler receives the fresh one that replaces it.
   */
  on(
    event: 'session_tree',
    handler: (
      event: { newLeafId: string | null; oldLeafId: string | null; fromExtension?: boolean },
      ctx: PiContext,
    ) => void,
  ): () => void;
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
 * `pi.sendMessage(..., {triggerTurn:true})` to deliver, the session abort to cut a turn,
 * `ctx.shutdown()` to exit, and seven pi events mapped onto `PiEvent`.
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
  /** The last assistant text pi reported; `undefined` until the first one (概念稿 §8.5). */
  private lastAssistant: string | undefined;

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
        aborted: event.outcome === 'aborted' ? true : undefined,
      });
    });
    // The last assistant text is the one fact the parent needs and no pi event above
    // carries (概念稿 §8.5). Tool-call-only messages leave the previous text in place:
    // "the last thing it said" is not "the last message it produced".
    //
    // The same event is the delivery acknowledgement (概念稿 §8.1): pi emits it for a
    // custom message once the message is in the session state — right before the first
    // model call of an idle-started run, and at the end of the turn for a deferred one.
    // A run that never prepares emits neither, which is exactly what lets the loop retry.
    pi.on('message_end', (event) => {
      const text = assistantTextOf(event.message);
      if (text !== undefined) this.lastAssistant = text;
      const deliveryId = deliveryIdOf(event.message);
      if (deliveryId !== undefined) this.publish({ type: 'delivery_ack', deliveryId });
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
        this.publish({ type: 'turn_end', error: { message: 'turn ended: aborted' }, aborted: true });
      }
      for (const listener of this.settleListeners) listener();
    });
  }

  /** The session context arrives on `session_start`; before that nothing is deliverable. */
  attachContext(ctx: PiContext): void {
    this.context = ctx;
  }

  async deliver(text: string, kind: DeliverKind, deliveryId: string): Promise<void> {
    // Fire-and-forget by pi's contract: `sendMessage` returns void and pi swallows a
    // start failure. The loop may not treat this return as "a run is now going".
    //
    // No `deliverAs`: omitting it does not mean "append after the turn". While streaming,
    // pi routes a `deliverAs`-less message through `agent.steer()` anyway
    // (agent-session.js, `sendCustomMessage`), so the safety of this call comes from the
    // loop's idle gate, not from this option (概念稿 §8.1). `deliveryId` rides in
    // `details` so the matching `message_end` can be recognised as the commit point.
    this.pi.sendMessage(
      { customType: PIGROUPS_CUSTOM_TYPE, content: text, display: true, details: { kind, deliveryId } },
      { triggerTurn: true },
    );
  }

  async notice(text: string): Promise<void> {
    // `triggerTurn: false` is the point: idle → pi appends the message at once; streaming →
    // pi defers it to the end of the turn (agent-session.js `_pendingCustomMessages`). It
    // never joins a running turn, so an abort cannot take it away, and it starts no new
    // turn, so a loop that is about to stop does not wake the member (概念稿 §8.3, §9).
    this.pi.sendMessage(
      { customType: PIGROUPS_CUSTOM_TYPE, content: text, display: true, details: { kind: 'message' } },
      { triggerTurn: false },
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
        logWarn(
          `[pigroups] abort() gave up after ${this.abortIdleTimeoutMs} ms: the turn is still running; the abort request stands`,
        );
        return;
      }
      await sleep(this.idlePollMs);
    }
  }

  isBusy(): boolean {
    // No context means `session_start` has not run yet: nothing is known to be idle, and
    // answering `false` would open the delivery gate at the one moment there is no turn
    // boundary to deliver at (概念稿 §8.1).
    const ctx = this.context;
    if (ctx === undefined) return true;
    return !ctx.isIdle();
  }

  lastAssistantText(): string | undefined {
    return this.lastAssistant;
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

/**
 * The text blocks of one finished pi message, or `undefined` when it is not an
 * assistant message or carries no text. pi's `message_end.message` is an
 * `AgentMessage`; only `role: 'assistant'` messages are the member's own words.
 */
function assistantTextOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== 'assistant' || !Array.isArray(record.content)) return undefined;
  const parts: string[] = [];
  for (const block of record.content) {
    if (typeof block !== 'object' || block === null) continue;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text);
  }
  const text = parts.join('\n');
  return text.trim() === '' ? undefined : text;
}

/**
 * The `deliveryId` a `message_end` carries, if it is one of this adapter's deliveries.
 * pi's custom messages have `role: 'custom'` and keep the extension's `details` verbatim.
 */
function deliveryIdOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const record = message as { role?: unknown; customType?: unknown; details?: unknown };
  if (record.role !== 'custom' || record.customType !== PIGROUPS_CUSTOM_TYPE) return undefined;
  if (typeof record.details !== 'object' || record.details === null) return undefined;
  const id = (record.details as { deliveryId?: unknown }).deliveryId;
  return typeof id === 'string' ? id : undefined;
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
