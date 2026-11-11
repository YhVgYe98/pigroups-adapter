/**
 * Probe-only extension for the turn-boundary delivery experiment.
 *
 * It records the pi events the adapter's delivery design depends on, with an ISO
 * timestamp and epoch milliseconds on every line, so the send, the turn boundary,
 * the custom message's `message_end` (the acknowledgement) and the assistant reply
 * can be compared against the session JSONL without guessing.
 *
 * This is not part of the adapter and imports nothing from `src/`: it only uses the
 * pi extension API, so it stays valid when the adapter is rewritten.
 *
 * Output: one JSON object per line in $BOUNDARY_PROBE_LOG.
 */

import { appendFileSync } from 'node:fs';

interface ProbeContext {
  isIdle(): boolean;
  sessionManager?: { getSessionFile?: () => string | undefined };
}

export default function boundaryProbe(pi: any): void {
  const logPath = process.env.BOUNDARY_PROBE_LOG;
  if (!logPath) return;

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

  const preview = (content: unknown, max = 240): string => {
    if (typeof content === 'string') return content.slice(0, max);
    if (!Array.isArray(content)) return '';
    return content
      .map((part: any) => {
        if (part?.type === 'text') return String(part.text ?? '');
        if (part?.type === 'thinking') return String(part.thinking ?? '');
        if (part?.type === 'toolCall') return `toolCall ${part.name}`;
        return '';
      })
      .join(' ')
      .slice(0, max);
  };

  let ctx: ProbeContext | undefined;

  pi.on('session_start', (event: unknown, context: ProbeContext) => {
    ctx = context;
    log('session_start', {
      reason: (event as { reason?: unknown })?.reason,
      isIdle: context.isIdle(),
      sessionFile: context.sessionManager?.getSessionFile?.() ?? null,
      cwd: process.cwd(),
    });
  });

  // pi's own boundary names. The adapter maps agent_start -> turn_start,
  // agent_before_settle -> turn_end and agent_settled(aborted) -> turn_end(aborted).
  pi.on('agent_start', () => log('agent_start', { isIdle: ctx?.isIdle() ?? null }));
  pi.on('agent_before_settle', (event: any) => log('before_settle', { outcome: event?.outcome }));
  pi.on('agent_settled', (event: any) =>
    log('agent_settled', { aborted: event?.aborted === true, isIdle: ctx?.isIdle() ?? null }),
  );

  pi.on('tool_execution_start', (event: any) =>
    log('tool_start', {
      toolName: event?.toolName,
      toolCallId: event?.toolCallId,
      argsPreview: JSON.stringify(event?.args ?? {}).slice(0, 300),
      isIdle: ctx?.isIdle() ?? null,
    }),
  );
  pi.on('tool_execution_end', (event: any) =>
    log('tool_end', {
      toolName: event?.toolName,
      toolCallId: event?.toolCallId,
      isError: event?.isError === true,
      durationMs: event?.durationMs,
      isIdle: ctx?.isIdle() ?? null,
    }),
  );

  // The acknowledgement the adapter commits on: a custom message whose details carry
  // the adapter's deliveryId emits message_end only when pi actually wrote it.
  pi.on('message_end', (event: any) => {
    const message = event?.message;
    const details = message?.details as Record<string, unknown> | undefined;
    log('message_end', {
      role: message?.role,
      customType: message?.customType,
      deliveryId: typeof details?.deliveryId === 'string' ? details.deliveryId : undefined,
      kind: typeof details?.kind === 'string' ? details.kind : undefined,
      text: preview(message?.content),
      messageTimestamp: message?.timestamp,
    });
  });

  pi.on('session_shutdown', (event: any) => {
    log('session_shutdown', { reason: event?.reason, isIdle: ctx?.isIdle() ?? null });
  });
}
