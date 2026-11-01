// Extract the facts a probe report quotes from one pi session file.
//
//   node session-facts.mjs <session.jsonl> <prefix>
//
// Writes <prefix>.json (machine readable) and <prefix>.txt (the lines quoted in
// report.md). Everything is read from the session file itself: pi records the
// system-prompt sections it sent (which list the built-in tools it enabled), every
// tool call, every assistant message and every tool result there.
import { readFileSync, writeFileSync } from 'node:fs';

const [file, prefix] = process.argv.slice(2);
const text = readFileSync(file, 'utf8');
const rawLines = text.split('\n');
const lines = rawLines.filter((line) => line.length > 0);

const bad = [];
const entries = [];
for (const [i, line] of lines.entries()) {
  try {
    entries.push(JSON.parse(line));
  } catch (error) {
    bad.push(`line ${i + 1}: ${error.message}`);
  }
}

const header = entries.find((entry) => entry.type === 'session') ?? {};
const model = entries.find((entry) => entry.type === 'model_change') ?? {};
const thinking = entries.find((entry) => entry.type === 'thinking_level_change') ?? {};
const systemMessage = entries.find((entry) => entry.type === 'message' && entry.message?.role === 'system');
const sections = systemMessage?.message?.sections ?? {};

// The system prompt's <tools> section lists the built-in tools pi enabled for this
// session: `- read: …` per line. Extension tools are not listed here; the startup
// banner is their evidence.
const builtinTools = [...String(sections.tools ?? '').matchAll(/^- ([A-Za-z0-9_]+):/gm)].map((match) => match[1]);
const skills = [...String(sections.skills ?? '').matchAll(/<name>([^<]+)<\/name>/g)].map((match) => match[1].trim());

const toolCalls = [];
const assistantTexts = [];
const toolResults = [];
for (const entry of entries) {
  const message = entry.message;
  if (entry.type !== 'message' || !message) continue;
  if (message.role === 'assistant') {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.type === 'toolCall') toolCalls.push({ at: entry.timestamp, name: part.name, arguments: part.arguments });
      if (part.type === 'text' && part.text) assistantTexts.push({ at: entry.timestamp, text: part.text });
    }
  }
  if (message.role === 'toolResult' || message.role === 'tool_result' || message.toolName) {
    const content = Array.isArray(message.content) ? message.content.map((part) => part.text ?? '').join('') : String(message.content ?? '');
    toolResults.push({ at: entry.timestamp, name: message.toolName ?? '', content });
  }
}

const last = entries[entries.length - 1] ?? {};
const facts = {
  file,
  lines: lines.length,
  badLines: bad,
  endsWithNewline: text.endsWith('\n'),
  session: { id: header.id, cwd: header.cwd, timestamp: header.timestamp },
  model: { provider: model.provider, modelId: model.modelId },
  thinkingLevel: thinking.thinkingLevel,
  sectionKeys: Object.keys(sections),
  builtinTools,
  skills,
  toolCalls,
  assistantTexts,
  toolResults,
  last: { type: last.type, role: last.message?.role, stopReason: last.message?.stopReason },
};

writeFileSync(`${prefix}.json`, JSON.stringify(facts, null, 2) + '\n');

const out = [];
out.push(`file=${file}`);
out.push(`lines=${lines.length} bad=${bad.length} endsWithNewline=${text.endsWith('\n')}`);
out.push(`session cwd=${header.cwd} id=${header.id}`);
out.push(`model=${model.provider}/${model.modelId} thinking=${thinking.thinkingLevel}`);
out.push(`sectionKeys=${Object.keys(sections).join(',')}`);
out.push(`builtinTools=${builtinTools.join(',') || '(none)'}`);
out.push(`skills=${skills.join(',') || '(none)'}`);
out.push(`toolCalls=${toolCalls.map((call) => call.name).join(',') || '(none)'}`);
for (const call of toolCalls) out.push(`  call ${call.at} ${call.name} ${JSON.stringify(call.arguments)}`);
out.push(`toolResults=${toolResults.map((result) => result.name || '?').join(',') || '(none)'}`);
for (const result of toolResults) out.push(`  result ${result.at} ${result.name}: ${result.content.slice(0, 300).replace(/\n/g, '\\n')}`);
out.push(`assistantTexts=${assistantTexts.length}`);
for (const said of assistantTexts) out.push(`  said ${said.at}: ${said.text.replace(/\n/g, '\\n').slice(0, 500)}`);
out.push(`last=${last.type} role=${last.message?.role ?? ''} stopReason=${last.message?.stopReason ?? ''}`);
writeFileSync(`${prefix}.txt`, out.join('\n') + '\n');
console.log(out.join('\n'));
