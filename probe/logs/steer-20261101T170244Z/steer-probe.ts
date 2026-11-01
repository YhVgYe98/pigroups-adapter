/**
 * Probe-only extension for the steer/abort experiments.
 *
 * It does exactly two things, both driven by files in $STEER_PROBE_DIR:
 *   steer-*.json  -> pi.sendMessage(..., { deliverAs: 'steer', triggerTurn: true })
 *   abort.flag    -> ctx.abort()
 *
 * Every pi event it can see is appended to $STEER_PROBE_LOG as one JSON line, with
 * an ISO timestamp and epoch milliseconds, so the send/abort request times can be
 * compared with the session JSONL without guessing.
 *
 * This is not part of the adapter. It exists because the adapter at HEAD aborts a
 * busy member before injecting a pg.steer, which cannot answer "what does a native
 * pi steer do while a tool is still running".
 */

import {
  appendFileSync,
  readFileSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';

interface ProbeContext {
  isIdle(): boolean;
  abort(): void;
  sessionManager?: { getSessionFile?: () => string | undefined };
}

export default function steerProbe(pi: any): void {
  const logPath = process.env.STEER_PROBE_LOG;
  if (!logPath) return;
  const triggerDir = process.env.STEER_PROBE_DIR;
  let ctx: ProbeContext | undefined;
  let timer: NodeJS.Timeout | undefined;
  const handled = new Set<string>();

  const log = (step: string, extra: Record<string, unknown> = {}): void => {
    appendFileSync(
      logPath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        epoch_ms: Date.now(),
        pid: process.pid,
        step,
        ...extra,
      })}\n`,
      'utf8',
    );
  };

  const poll = (): void => {
    if (!triggerDir || !ctx) return;
    let names: string[];
    try {
      names = readdirSync(triggerDir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (handled.has(name)) continue;
      const path = join(triggerDir, name);
      try {
        if (name.startsWith('steer-') && name.endsWith('.json')) {
          handled.add(name);
          const payload = JSON.parse(readFileSync(path, 'utf8')) as { text?: string; marker?: string };
          const text = String(payload.text ?? '');
          log('steer_send_request', {
            file: name,
            marker: payload.marker,
            text,
            isIdle: ctx.isIdle(),
            sessionFile: ctx.sessionManager?.getSessionFile?.() ?? null,
          });
          const startedAt = Date.now();
          try {
            pi.sendMessage(
              {
                customType: 'steer-probe',
                content: text,
                display: true,
                details: { marker: payload.marker, probe: true },
              },
              { triggerTurn: true, deliverAs: 'steer' },
            );
            log('steer_send_return', {
              file: name,
              marker: payload.marker,
              send_ms: Date.now() - startedAt,
              isIdle: ctx.isIdle(),
            });
          } catch (err) {
            log('steer_send_error', {
              file: name,
              marker: payload.marker,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          renameSync(path, `${path}.done`);
        } else if (name === 'abort.flag') {
          handled.add(name);
          log('abort_request', { isIdle: ctx.isIdle(), sessionFile: ctx.sessionManager?.getSessionFile?.() ?? null });
          const startedAt = Date.now();
          try {
            ctx.abort();
            log('abort_return', { abort_ms: Date.now() - startedAt, isIdle: ctx.isIdle() });
          } catch (err) {
            log('abort_error', { error: err instanceof Error ? err.message : String(err) });
          }
          renameSync(path, `${path}.done`);
        }
      } catch (err) {
        log('trigger_error', { file: name, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  pi.on('session_start', (_event: unknown, context: ProbeContext) => {
    ctx = context;
    log('session_start', {
      isIdle: context.isIdle(),
      cwd: process.cwd(),
      sessionFile: context.sessionManager?.getSessionFile?.() ?? null,
      triggerDir,
    });
    if (timer) clearInterval(timer);
    timer = setInterval(poll, 50);
    timer.unref?.();
  });

  pi.on('agent_start', () => log('agent_start', { isIdle: ctx?.isIdle() ?? null }));
  pi.on('agent_before_settle', (event: any) => log('before_settle', { event }));
  pi.on('agent_settled', (event: any) => log('agent_settled', { event, isIdle: ctx?.isIdle() ?? null }));
  pi.on('tool_execution_start', (event: any) =>
    log('tool_start', { toolName: event.toolName, args: event.args, isIdle: ctx?.isIdle() ?? null }),
  );
  pi.on('tool_execution_end', (event: any) =>
    log('tool_end', {
      toolName: event.toolName,
      isError: event.isError,
      result: event.result,
      isIdle: ctx?.isIdle() ?? null,
    }),
  );
  pi.on('session_shutdown', (event: any) => {
    if (timer) clearInterval(timer);
    log('session_shutdown', { event, isIdle: ctx?.isIdle() ?? null });
  });
}
