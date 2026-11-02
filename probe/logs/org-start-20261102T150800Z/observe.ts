// Passive observer for the real-machine probe. It registers NO tools, so the model's
// tool surface is exactly what the adapter under test registers. On session start and
// after every tool execution it appends pi's own active/all tool sets to a JSONL file.
//
// Loaded with -e alongside the package from settings; PROBE_TOOLS_FILE names the output.
import { appendFileSync } from 'node:fs';

export default function observe(pi: any): void {
  const file = process.env.PROBE_TOOLS_FILE;
  if (!file) return;

  const dump = (event: string, extra: Record<string, unknown> = {}): void => {
    try {
      appendFileSync(
        file,
        `${JSON.stringify({
          at: new Date().toISOString(),
          pid: process.pid,
          event,
          ...extra,
          active: pi.getActiveTools(),
          all: pi.getAllTools().map((tool: { name: string }) => tool.name),
        })}\n`,
      );
    } catch {
      // Observing must never break the session under test.
    }
  };

  pi.on('session_start', () => dump('session_start'));
  pi.on('tool_execution_end', (event: { toolName?: string; isError?: boolean }) =>
    dump('tool_execution_end', { tool: event?.toolName, isError: event?.isError }),
  );
}
