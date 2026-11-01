/**
 * PiGroups adapter probe — three assumptions about pi, checked on a real session.
 *
 * The adapter under test (src/surface.ts, src/loop.ts) relies on:
 *
 *   P1  `pi.sendMessage(..., { triggerTurn: true })` called from inside an
 *       `agent_settled` handler really starts a new agent run (the session is
 *       already idle at that point, and pi does not swallow the message).
 *   P2  `ctx.abort()` stops a turn that sits inside a running tool, and
 *       `ctx.isIdle()` turns true within a bounded time afterwards.
 *   P3  `session_shutdown` handlers run, and their promise is awaited before
 *       the process exits.
 *
 * This file uses the pi extension API only; it does not import anything from
 * the adapter, so it stays valid if the adapter is rewritten.
 *
 * Output: one JSON object per line, appended to $PROBE_LOG. Steps:
 *   start, before_agent_start, turn_start, before_settle, settled_N,
 *   delivered, tool_start, tool_end, tool_enter, abort_seen, abort_called,
 *   idle | idle_timeout, pi_turn_end, assistant_end, shutdown_start,
 *   shutdown_done, process_exit. (`pi_turn_end` is pi's own event; the adapter's
 *   PiEvent.turn_end is a different thing.)
 *
 * Environment:
 *   PROBE_LOG             required; append-only JSONL output path. Unset => no-op.
 *   PROBE_DIR             directory holding the external `abort` trigger file.
 *                         Unset => P2 is skipped (logged as p2_skipped).
 *   PROBE_ABORT_WAIT_MS   bound for the idle wait after abort (default 3000, the
 *                         adapter's own ABORT_IDLE_TIMEOUT_MS).
 *   PROBE_IGNORE_SIGNAL=1 make probe_sleep ignore the AbortSignal it is handed, so
 *                         P2 tests a tool that does not cooperate. The default (0)
 *                         keeps the cooperating control: it returns from its own
 *                         signal listener.
 *   PROBE_SHUTDOWN_SETTLE_MS  async work inside session_shutdown (default 3000);
 *                         long enough that "exit 0 after 357 ms" cannot fake an await.
 *   PROBE_ECHO=1          mirror every line to stderr.
 *   PROBE_SEED_PROMPT     unused here; the seed prompt is a cli argument.
 */

import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** How often the tool looks for the external abort trigger file. */
const ABORT_FILE_POLL_MS = 100;
/** How often the tool samples ctx.isIdle() after it asked for an abort. */
const IDLE_POLL_MS = 25;
/** Bound for the idle wait: a turn that never settles is a failed probe, not a slow one. */
const DEFAULT_ABORT_WAIT_MS = 20_000;
/** The probe tool never sleeps longer than this, whatever the model asks for. */
const MAX_TOOL_SECONDS = 60;
/** Default async work inside the session_shutdown handler; see PROBE_SHUTDOWN_SETTLE_MS. */
const DEFAULT_SHUTDOWN_SETTLE_MS = 3000;

const P1_PROMPT = 'This is an automated probe. Reply with the single word pong and nothing else.';
const P2_PROMPT =
  'Call the tool probe_sleep exactly once with seconds=60. Do not answer with text before the tool call.';
const P3_PROMPT = 'Reply with the single word pong and nothing else. This delivery follows an aborted run.';

const PREVIEW_CHARS = 160;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function preview(value: unknown): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (Array.isArray(value)) {
    text = value
      .map((part) => {
        if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
          return String((part as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join('');
  } else {
    text = JSON.stringify(value) ?? String(value);
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/** Read a field without letting a throw escape into pi's event dispatch. */
function attempt<T>(read: () => T): T | string {
  try {
    return read();
  } catch (error) {
    return `threw: ${errorText(error)}`;
  }
}

export default function probeExtension(pi: ExtensionAPI): void {
  const logPath = (process.env.PROBE_LOG ?? '').trim();
  if (!logPath) {
    // The factory must not throw. Without a log path there is nothing useful to do.
    console.error('[probe] PROBE_LOG is not set; probe registers nothing');
    return;
  }

  const probeDir = (process.env.PROBE_DIR ?? '').trim();
  const abortFile = probeDir ? join(probeDir, 'abort') : '';
  const abortWaitMs = readInt('PROBE_ABORT_WAIT_MS', DEFAULT_ABORT_WAIT_MS);
  const ignoreSignal = process.env.PROBE_IGNORE_SIGNAL === '1';
  const shutdownSettleMs = readInt('PROBE_SHUTDOWN_SETTLE_MS', DEFAULT_SHUTDOWN_SETTLE_MS);
  const echo = process.env.PROBE_ECHO === '1';
  const startedAt = Date.now();

  const record = (fields: Record<string, unknown>): void => {
    // Field order matters: the runner greps for `"step":"x"` followed by other keys.
    const line = `${JSON.stringify({ ms: Date.now() - startedAt, pid: process.pid, ...fields })}\n`;
    try {
      appendFileSync(logPath, line);
    } catch (error) {
      console.error(`[probe] cannot append to ${logPath}: ${errorText(error)}`);
    }
    if (echo) process.stderr.write(line);
  };

  let runs = 0;
  let settled = 0;
  let shutdowns = 0;
  let lastDeliveryAt = 0;
  let lastDeliveryStage = '';
  let abortedDeliverySent = false;
  let shutdownDoneAt = 0;

  // The exit listener is registered before any run starts. `process.on('exit')` is the
  // only place that can timestamp an exit that happens *after* the shutdown handler
  // finished; without it, "exit 0 within 357 ms" cannot distinguish "the handler was
  // awaited" from "a timer kept the process alive anyway".
  process.on('exit', (code) => {
    record({
      step: 'process_exit',
      code,
      at: Date.now(),
      shutdown_done_at: shutdownDoneAt || null,
      after_shutdown_done_ms: shutdownDoneAt ? Date.now() - shutdownDoneAt : null,
      shutdown_settle_ms: shutdownSettleMs,
    });
  });

  // ---------------------------------------------------------------- P1 / P3 events

  pi.on('session_start', (event, ctx) => {
    record({
      step: 'start',
      reason: event.reason,
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      isIdle: attempt(() => ctx.isIdle()),
      hasPendingMessages: attempt(() => ctx.hasPendingMessages()),
      pane: process.env.HERDR_PANE_ID ?? null,
      node: process.version,
      ignoreSignal,
      shutdownSettleMs,
      argv: process.argv.slice(2),
    });
  });

  pi.on('before_agent_start', (event) => {
    // The discriminator for a real "deliver starts a run": a run started by
    // sendMessage(..., {triggerTurn:true}) reports messageType "custom" with our
    // customType. A run started by user input reports "user" instead.
    record({
      step: 'before_agent_start',
      messageType: event.messageType,
      customType: event.messageType === 'custom' ? event.message.customType : null,
      content: event.messageType === 'custom' ? preview(event.message.content) : preview(event.prompt),
    });
  });

  pi.on('agent_start', (_event, ctx) => {
    runs += 1;
    const now = Date.now();
    record({
      step: 'turn_start',
      run: runs,
      delivery_stage: lastDeliveryStage || null,
      since_delivery_ms: lastDeliveryAt ? now - lastDeliveryAt : null,
      isIdle: attempt(() => ctx.isIdle()),
      hasPendingMessages: attempt(() => ctx.hasPendingMessages()),
    });
  });

  pi.on('agent_before_settle', (event) => {
    // This is the event the adapter maps to its own turn_end, so its outcome is
    // exactly what the adapter would report to the platform.
    record({
      step: 'before_settle',
      outcome: event.outcome,
      canContinue: event.context?.canContinue ?? null,
    });
  });

  pi.on('agent_settled', (event, ctx) => {
    settled += 1;
    // Read synchronously inside the handler: this is precisely what the adapter's
    // isBusy() gate sees when its settle callback runs.
    const isIdle = attempt(() => ctx.isIdle());
    const hasPendingMessages = attempt(() => ctx.hasPendingMessages());

    record({
      step: settled === 1 ? 'settled_1' : `settled_${settled}`,
      settled,
      aborted: event.aborted,
      isIdle,
      hasPendingMessages,
    });

    if (settled === 1) {
      const before = Date.now();
      pi.sendMessage(
        { customType: 'probe', content: P1_PROMPT, display: true, details: { stage: 'p1' } },
        { triggerTurn: true },
      );
      lastDeliveryAt = Date.now();
      lastDeliveryStage = 'p1';
      record({
        step: 'delivered',
        stage: 'p1',
        idle_in_handler: isIdle,
        sendMessage_sync_ms: Date.now() - before,
      });
      return;
    }

    if (settled === 2) {
      if (!abortFile) {
        record({ step: 'p2_skipped', reason: 'PROBE_DIR is not set' });
        return;
      }
      const before = Date.now();
      pi.sendMessage(
        { customType: 'probe', content: P2_PROMPT, display: true, details: { stage: 'p2' } },
        { triggerTurn: true },
      );
      lastDeliveryAt = Date.now();
      lastDeliveryStage = 'p2';
      record({
        step: 'delivered',
        stage: 'p2',
        idle_in_handler: isIdle,
        sendMessage_sync_ms: Date.now() - before,
      });
      return;
    }

    // A run killed by an abort skips agent_before_settle, so the adapter closes the
    // turn from this same agent_settled event and then flushes. Delivering here proves
    // sendMessage starts a run from the aborted-settle path too, not only from the
    // normal settle P1 covers; run.sh asserts the new agent_start.
    if (event.aborted && !abortedDeliverySent) {
      abortedDeliverySent = true;
      const before = Date.now();
      pi.sendMessage(
        { customType: 'probe', content: P3_PROMPT, display: true, details: { stage: 'p3' } },
        { triggerTurn: true },
      );
      lastDeliveryAt = Date.now();
      lastDeliveryStage = 'p3';
      record({
        step: 'delivered',
        stage: 'p3',
        idle_in_handler: isIdle,
        sendMessage_sync_ms: Date.now() - before,
      });
    }
  });

  pi.on('turn_end', (event) => {
    const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
    record({
      // pi's own event, distinct from the adapter's PiEvent.turn_end.
      step: 'pi_turn_end',
      turnIndex: event.turnIndex,
      outcome: event.outcome,
      role: message.role ?? null,
      stopReason: message.stopReason ?? null,
      errorMessage: message.errorMessage ?? null,
    });
  });

  pi.on('tool_execution_start', (event) => {
    record({
      step: 'tool_start',
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      args: preview(event.args),
    });
  });

  pi.on('tool_execution_end', (event) => {
    record({
      step: 'tool_end',
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      isError: event.isError,
      durationMs: event.durationMs ?? null,
    });
  });

  pi.on('message_end', (event) => {
    const message = event.message as { role?: string; stopReason?: string; content?: unknown };
    if (message.role !== 'assistant') return;
    record({
      step: 'assistant_end',
      stopReason: message.stopReason ?? null,
      text: preview(message.content),
    });
  });

  // ---------------------------------------------------------------- P2 tool

  const probeSleep = defineTool({
    name: 'probe_sleep',
    label: 'Probe Sleep',
    description:
      'Probe-only tool. Waits up to the given number of seconds and then returns. The probe runner aborts the session from outside; this tool never initiates an abort on its own.',
    parameters: Type.Object({
      seconds: Type.Number({ description: 'Seconds to wait before returning (clamped to 1..60).' }),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const enterAt = Date.now();
      const seconds = Math.min(Math.max(Math.trunc(params.seconds), 1), MAX_TOOL_SECONDS);
      record({
        step: 'tool_enter',
        tool: 'probe_sleep',
        toolCallId,
        seconds,
        signalPresent: signal !== undefined,
        ignoreSignal,
        isIdle: attempt(() => ctx.isIdle()),
      });

      return await new Promise((resolve) => {
        let returned = false;
        let abortRequested = false;
        let sleepTimer: ReturnType<typeof setTimeout> | undefined;
        let abortWatch: ReturnType<typeof setInterval> | undefined;
        let idleWatch: ReturnType<typeof setInterval> | undefined;

        const stopAbortWatch = (): void => {
          if (abortWatch !== undefined) {
            clearInterval(abortWatch);
            abortWatch = undefined;
          }
        };

        // Started from inside the tool when the trigger file appears. It keeps
        // running after execute() returns, so it can observe the settle that the
        // tool return itself is blocking.
        const watchIdle = (abortCalledAt: number): void => {
          idleWatch = setInterval(() => {
            const elapsed = Date.now() - abortCalledAt;
            const idle = attempt(() => ctx.isIdle());
            if (idle === true) {
              if (idleWatch !== undefined) clearInterval(idleWatch);
              idleWatch = undefined;
              record({ step: 'idle', wait_ms: elapsed, toolReturned: returned });
              return;
            }
            if (elapsed >= abortWaitMs) {
              if (idleWatch !== undefined) clearInterval(idleWatch);
              idleWatch = undefined;
              record({ step: 'idle_timeout', wait_ms: elapsed, limit_ms: abortWaitMs, isIdle: idle, toolReturned: returned });
            }
          }, IDLE_POLL_MS);
        };

        const finish = (why: 'aborted' | 'timeout'): void => {
          if (returned) return;
          returned = true;
          stopAbortWatch();
          if (sleepTimer !== undefined) {
            clearTimeout(sleepTimer);
            sleepTimer = undefined;
          }
          const ranMs = Date.now() - enterAt;
          record({
            step: 'tool_return',
            tool: 'probe_sleep',
            toolCallId,
            why,
            ran_ms: ranMs,
            isIdle: attempt(() => ctx.isIdle()),
          });
          resolve({
            content: [{ type: 'text' as const, text: `probe_sleep finished (${why}) after ${ranMs} ms` }],
            details: { why, ranMs },
          });
        };

        if (signal && !ignoreSignal) {
          if (signal.aborted) {
            finish('aborted');
          } else {
            signal.addEventListener('abort', () => finish('aborted'), { once: true });
          }
        }
        if (signal && ignoreSignal) {
          record({ step: 'tool_signal_ignored', tool: 'probe_sleep', toolCallId });
        }

        sleepTimer = setTimeout(() => finish('timeout'), seconds * 1000);

        if (!abortFile) {
          record({ step: 'tool_no_abort_file', tool: 'probe_sleep', reason: 'PROBE_DIR is not set' });
          return;
        }

        // Polling for the external trigger. The timer lives inside execute(),
        // never in the extension factory.
        abortWatch = setInterval(() => {
          if (abortRequested || returned) return;
          let present = false;
          try {
            present = existsSync(abortFile);
          } catch {
            present = false;
          }
          if (!present) return;
          abortRequested = true;
          record({
            step: 'abort_seen',
            toolCallId,
            waited_ms: Date.now() - enterAt,
            isIdle: attempt(() => ctx.isIdle()),
          });
          const abortAt = Date.now();
          let abortError: string | null = null;
          try {
            // Fire-and-forget by contract: ctx.abort() returns void.
            ctx.abort();
          } catch (error) {
            abortError = errorText(error);
          }
          record({
            step: 'abort_called',
            toolCallId,
            abort_sync_ms: Date.now() - abortAt,
            abortError,
            isIdle: attempt(() => ctx.isIdle()),
            hasPendingMessages: attempt(() => ctx.hasPendingMessages()),
          });
          watchIdle(abortAt);
        }, ABORT_FILE_POLL_MS);
      });
    },
  });

  pi.registerTool(probeSleep);

  // ---------------------------------------------------------------- P3

  pi.on('session_shutdown', async (event, ctx) => {
    shutdowns += 1;
    record({
      step: 'shutdown_start',
      shutdown: shutdowns,
      reason: event.reason,
      targetSessionFile: event.targetSessionFile ?? null,
      mode: ctx.mode,
      isIdle: attempt(() => ctx.isIdle()),
    });
    const at = Date.now();
    // Deliberately not unref'ed, and deliberately seconds long: if pi does not await
    // the handler, the process exits before this timer fires and neither this line nor
    // process_exit's after_shutdown_done_ms appears.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, shutdownSettleMs);
    });
    shutdownDoneAt = Date.now();
    record({ step: 'shutdown_done', shutdown: shutdowns, at: shutdownDoneAt, waited_ms: shutdownDoneAt - at });
    if (probeDir) {
      try {
        writeFileSync(join(probeDir, `shutdown_done_${shutdowns}`), `${Date.now()}\n`);
      } catch {
        // best effort only
      }
    }
  });
}
