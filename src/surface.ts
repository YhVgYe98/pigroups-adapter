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
  /** Hand a block of text to the agent as one turn. Returns when committed, not when done. */
  deliver(text: string, kind: DeliverKind): Promise<void>;
  /** Cut the running turn and wait until idle. Returns at once when already idle. */
  abort(): Promise<void>;
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
 * The real `PiSurface`. It is the whole of the pi-specific glue:
 * `pi.sendMessage(..., {triggerTurn:true})` to deliver, the session abort to cut
 * a turn, `ctx.shutdown()` to exit, and five pi events mapped onto `PiEvent`.
 */
export class PiSurfaceAdapter implements PiSurface {
  private readonly pi: PiLike;
  private readonly settleListeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: PiEvent) => void>();
  private context: PiContext | undefined;

  constructor(pi: PiLike) {
    this.pi = pi;

    // pi event → PiEvent (设计说明 §2.1). `agent_before_settle` carries the run
    // outcome, so it is the turn_end source; `agent_settled` only means idle.
    pi.on('agent_start', () => this.publish({ type: 'turn_start' }));
    pi.on('tool_execution_start', (event) =>
      this.publish({ type: 'tool_start', name: event.toolName, argsPreview: previewArgs(event.args) }),
    );
    pi.on('tool_execution_end', (event) =>
      this.publish({ type: 'tool_end', name: event.toolName, ok: !event.isError }),
    );
    pi.on('agent_before_settle', (event) =>
      this.publish({
        type: 'turn_end',
        error: event.outcome === 'completed' ? undefined : { message: `turn ended: ${event.outcome}` },
      }),
    );
    pi.on('agent_settled', () => {
      for (const listener of this.settleListeners) listener();
    });
  }

  /** The session context arrives on `session_start`; before that nothing is deliverable. */
  attachContext(ctx: PiContext): void {
    this.context = ctx;
  }

  async deliver(text: string, kind: DeliverKind): Promise<void> {
    this.pi.sendMessage(
      { customType: PIGROUPS_CUSTOM_TYPE, content: text, display: true, details: { kind } },
      { triggerTurn: true },
    );
  }

  async abort(): Promise<void> {
    const ctx = this.context;
    if (!ctx || ctx.isIdle()) return;
    ctx.abort();
    while (!ctx.isIdle()) await sleep(IDLE_POLL_MS);
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
