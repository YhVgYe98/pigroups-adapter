// Flatten a pi session JSONL into readable lines for the level-4 journal.
// Usage: node extract.mjs <session.jsonl> <out.md>
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
const lines = readFileSync(input, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const out = [];

for (const line of lines) {
  if (line.type === 'session') {
    out.push(`# session ${line.id} cwd=${line.cwd} at ${line.timestamp}`);
    continue;
  }
  if (line.type === 'custom_message') {
    out.push(`\n## [${line.timestamp}] INJECTED ${line.customType} (${line.details?.kind ?? '?'})\n${indent(line.content)}`);
    continue;
  }
  if (line.type !== 'message') continue;
  const message = line.message;
  const stamp = line.timestamp;
  if (message.role === 'system') {
    out.push(`\n## [${stamp}] system prompt (${String(message.content).length} chars, omitted)`);
    continue;
  }
  if (message.role === 'user') {
    out.push(`\n## [${stamp}] USER\n${indent(textOf(message.content))}`);
    continue;
  }
  if (message.role === 'assistant') {
    out.push(`\n## [${stamp}] ASSISTANT`);
    for (const part of [].concat(message.content ?? [])) {
      if (part.type === 'thinking') out.push(`thinking: ${part.thinking}`);
      else if (part.type === 'text') out.push(`text: ${part.text}`);
      else if (part.type === 'toolCall') out.push(`toolCall ${part.name} ${JSON.stringify(part.arguments)}`);
      else out.push(`${part.type}: ${JSON.stringify(part).slice(0, 400)}`);
    }
    continue;
  }
  if (message.role === 'toolResult') {
    out.push(`\n## [${stamp}] TOOL RESULT ${message.toolName} isError=${message.isError} (${message.durationMs}ms)\n${indent(textOf(message.content))}`);
    continue;
  }
  out.push(`\n## [${stamp}] ${message.role}\n${indent(JSON.stringify(message).slice(0, 1000))}`);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return [].concat(content ?? [])
    .map((part) => (part.type === 'text' ? part.text : JSON.stringify(part)))
    .join('\n');
}

function indent(text) {
  return String(text)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

writeFileSync(output, `${out.join('\n')}\n`);
