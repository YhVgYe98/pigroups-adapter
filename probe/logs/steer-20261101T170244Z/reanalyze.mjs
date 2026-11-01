// Regenerate a readable, verbatim timeline for every archived session in this run.
// Usage: node reanalyze.mjs <run-dir>
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('run dir required');

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .map((part) => {
      if (part?.type === 'text') return part.text ?? '';
      if (part?.type === 'thinking') return `[thinking] ${part.thinking ?? ''}`;
      if (part?.type === 'toolCall') return `[toolCall ${part.name} ${JSON.stringify(part.arguments)}]`;
      return `[${part?.type}]`;
    })
    .join('\n');
}

for (const caseName of readdirSync(root)) {
  const dir = join(root, caseName);
  if (!statSync(dir).isDirectory()) continue;
  for (const sessionName of ['session.jsonl', 'session-after-followup.jsonl']) {
    const path = join(dir, sessionName);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    const out = [`# ${caseName}/${sessionName}`, `# raw JSONL: ${path}`, ''];
    let started = false;
    lines.forEach((line, index) => {
      let entry;
      try { entry = JSON.parse(line); } catch { out.push(`[${index}] PARSE ERROR ${line}`); return; }
      if (entry.type === 'message' && entry.message?.role === 'user') started = true;
      if (!started && entry.type !== 'custom_message') return;
      const stamp = entry.timestamp ?? '—';
      if (entry.type === 'custom_message') {
        out.push(`[${index}] ${stamp} CUSTOM ${entry.customType} kind=${entry.details?.kind ?? '?'}`);
        out.push(`    ${String(entry.content).replace(/\n/g, '\n    ')}`);
        out.push(`    RAW ${line}`);
        return;
      }
      if (entry.type !== 'message') {
        out.push(`[${index}] ${stamp} ${entry.type}`);
        out.push(`    RAW ${line}`);
        return;
      }
      const m = entry.message;
      out.push(`[${index}] ${stamp} ${m.role}${m.stopReason ? ` stopReason=${m.stopReason}` : ''}${m.errorMessage ? ` errorMessage=${JSON.stringify(m.errorMessage)}` : ''}${m.toolName ? ` toolName=${m.toolName} isError=${m.isError} durationMs=${m.durationMs}` : ''}`);
      const text = textOf(m);
      if (text) out.push(`    ${text.replace(/\n/g, '\n    ')}`);
      out.push(`    RAW ${line}`);
      out.push('');
    });
    writeFileSync(join(dir, sessionName === 'session.jsonl' ? 'timeline-full.txt' : 'timeline-after-followup-full.txt'), `${out.join('\n')}\n`, 'utf8');
  }
}
