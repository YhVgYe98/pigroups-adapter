# Steer and abort on a live pi 1.4.0 — E1/E2

Run: `steer-20261101T170244Z` · pi 1.4.0 · adapter HEAD `48feef2` · PiGroups 0.2.0 ·
model `deepseek/deepseek-flash` (thinking max) · one throwaway platform on `127.0.0.1:36691`.

## Conditions that matter

- Each case is its own child member of a throwaway root, its own herdr tab, its own
  `--session-dir`, and its own adapter directory. The member was started with:
  `pi -ne -e src/extension.ts -e probe/steer-probe.ts -ns -np -nc --no-mcp --session-dir … --model deepseek/deepseek-flash`.
- The long tool is the built-in `bash` with `sleep 60; echo SLEEPDONE`. The short control is
  `sleep 5; echo SLEEPDONE`. The model called it with no other tool; probe logs confirm
  `tool_start` and wall time 60 004 ms / 5 005 ms.
- **Native steer** means `pi.sendMessage(..., { triggerTurn: true, deliverAs: 'steer' })` from
  `probe/steer-probe.ts` while the tool is running. **Platform steer** means
  `POST /v1/control {cmd:'pg.steer'}` to the real adapter. I had to run both: at HEAD the adapter
  does not inject a steer into a busy turn — it aborts the turn first (`src/loop.ts:799`).
- **Platform abort** means `POST /v1/control {cmd:'pg.abort'}` from a human token to the adapter.
- Markers were sent 5 s after `tool_start` (long cases) or 1.5 s after `tool_start` (short case).

## E1 — when a steer is seen

**Verdict: the native steer was NOT seen until the tool returned. The marker entry itself is
written 1 ms after the tool result, and the first assistant mention comes after that. `sendMessage`
returned in 0–1 ms while the tool still had ~55 s to run; that return means “queued”, not “seen”.**

| case | steer send (probe/control) | bash tool result | marker entry in JSONL | first assistant marker | immediate |
|---|---|---|---|---|---|
| long, native | `17:02:54.999Z` (send returned `17:02:55.000Z`, `isIdle=false`) | `17:03:49.880Z` (60 004 ms, not aborted) | `17:03:49.881Z` (**+1 ms**) | `17:03:50.468Z` (+587 ms) | **SEEN after tool returned** |
| short, native | `17:03:58.435Z` (send returned same ms, `isIdle=false`) | `17:04:01.772Z` (5 005 ms) | `17:04:01.773Z` (**+1 ms**) | `17:04:02.539Z` (+766 ms) | **SEEN after tool returned** |
| long, adapter `pg.steer` | platform post `17:04:13.140Z` | `17:04:13.146Z` **isError=true, “Command aborted”** (5 129 ms) | `17:04:13.196Z` (+50 ms) | `17:04:14.399Z` | **SEEN, but the adapter cut the tool** |

Verbatim long-native JSONL (indices 5–8 in `e1-long-native/timeline-full.txt`):

```json
{"type":"message","id":"f8fea11d","parentId":"da2f8f6d","timestamp":"2026-11-01T17:02:49.875Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_00_ET_QJP3D1YqZlKVlrznnyXa2991","name":"bash","arguments":{"command":"sleep 60; echo SLEEPDONE","timeout":90}}],"stopReason":"toolUse","timestamp":1793552569082}}
{"type":"message","id":"430216e0","parentId":"f8fea11d","timestamp":"2026-11-01T17:03:49.880Z","message":{"role":"toolResult","toolCallId":"call_00_ET_QJP3D1YqZlKVlrznnyXa2991","toolName":"bash","content":[{"type":"text","text":"SLEEPDONE\n"}],"isError":false,"durationMs":60004,"timestamp":1793552629880}}
{"type":"custom_message","customType":"steer-probe","content":"STEER-MARK-7f31: when you next see this marker, reply with exactly \"STEER-MARK-7f31\" and then stop. Do not call any tool.","display":true,"details":{"marker":"STEER-MARK-7f31","probe":true},"id":"b1511afb","parentId":"430216e0","timestamp":"2026-11-01T17:03:49.881Z"}
{"type":"message","id":"313735dc","parentId":"b1511afb","timestamp":"2026-11-01T17:03:50.468Z","message":{"role":"assistant","content":[{"type":"text","text":"STEER-MARK-7f31"}],"stopReason":"stop","timestamp":1793552629882}}
```

The short control shows the same shape with a 5 s tool: send `17:03:58.435Z`, result
`17:04:01.772Z`, marker `17:04:01.773Z`, assistant `17:04:02.539Z`.

**This contradicts the current adapter, not pi.** The third row is what the platform `pg.steer`
actually does today: `src/loop.ts` aborts the busy member before injecting. The tool ended at
`17:04:13.146Z` with `"Command aborted"`, only 5.1 s into a 60 s sleep. So today's adapter avoids
the 55 s deferral by killing the work. If delivery becomes an unconditional steer, this row will
turn into the first row: the message will sit until the tool returns.

## E2 — does abort swallow a steered message

**Verdict for the native steer + platform abort: LOST.** `STEER-MARK-9c02` is absent from the
session JSONL entirely — no `custom_message`, no assistant mention, not even after an unrelated
follow-up turn 9 s later. It was never persisted, so there is nothing for a restart to replay.

Timeline (`e2-native-steer-platform-abort`):

| event | timestamp |
|---|---|
| bash tool call | `17:04:20.391Z` |
| native steer send request / return | `17:04:25.585Z` / `17:04:25.585Z` (`isIdle=false`) |
| platform `pg.abort` posted | `17:04:26.034Z` (449 ms after the steer) |
| bash result `isError=true`, `"Command aborted"` | `17:04:26.038Z` |
| assistant `stopReason=error`, `"This operation was aborted"` | `17:04:26.040Z` |
| follow-up user “Reply with exactly BANANA…” | `17:04:35.353Z` |
| assistant `BANANA` (no marker anywhere) | `17:04:36.176Z` |
| marker occurrences in the whole session file | **0** |

Verbatim JSONL tail (the steer should be between the tool result and the error assistant; it is not there):

```json
{"type":"message","id":"19f8d25d","parentId":"9c2479f7","timestamp":"2026-11-01T17:04:26.038Z","message":{"role":"toolResult","toolCallId":"call_00_EiJMcFXUHqEUslI9qjp02758","toolName":"bash","content":[{"type":"text","text":"Command aborted"}],"details":{},"isError":true,"durationMs":5645,"timestamp":1793552666038}}
{"type":"message","id":"67afc21e","parentId":"19f8d25d","timestamp":"2026-11-01T17:04:26.040Z","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"This operation was aborted","timestamp":1793552666039,"durationMs":0}}
{"type":"message","id":"2c65bf03","parentId":"67afc21e","timestamp":"2026-11-01T17:04:35.353Z","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly BANANA and stop. Do not call any tool."}],"timestamp":1793552675352}}
{"type":"message","id":"cd00912e","parentId":"2c65bf03","timestamp":"2026-11-01T17:04:36.176Z","message":{"role":"assistant","content":[{"type":"text","text":"BANANA"}],"stopReason":"stop","timestamp":1793552675354}}
```

The adapter's files for this member are **not** evidence of delivery, because the steer bypassed
the adapter: `adapter-view/journal/` is empty and there is no `injected.json`
(`adapter-view/injected.missing`). The probe extension is the only component that saw the steer,
and its log has the send at `17:04:25.585Z` followed by nothing.

**Verdict for the current adapter `pg.steer` followed by `pg.abort`: KEPT-BUT-UNSEEN, then seen on
the next prompt.** This is the dangerous-but-not-lost shape the brief asks about.

| event | timestamp |
|---|---|
| bash tool call | `17:04:42.598Z` |
| platform `pg.steer` posted | `17:04:47.790Z` |
| bash result `isError=true`, `"Command aborted"` (the adapter cut it because busy) | `17:04:47.796Z` |
| marker `custom_message` `customType=pigroups`, `details.kind=control` | `17:04:47.846Z` |
| platform `pg.abort` posted | `17:04:48.043Z` |
| assistant `stopReason=aborted`, `"Operation aborted"` (the marker's new run cut after 200 ms) | `17:04:48.047Z` |
| follow-up user “Reply with exactly BANANA…” | `17:04:57.360Z` |
| assistant mentions marker in thinking, then says `BANANA` | `17:04:58.357Z` |

Verbatim marker + abort:

```json
{"type":"custom_message","customType":"pigroups","content":"STEER-MARK-9c02A: when you next see this marker, reply with exactly \"STEER-MARK-9c02A\" and then stop. Do not call any tool.","display":true,"details":{"kind":"control"},"id":"84f71bca","parentId":"823ddbe8","timestamp":"2026-11-01T17:04:47.846Z"}
{"type":"message","id":"d5d94083","parentId":"84f71bca","timestamp":"2026-11-01T17:04:48.047Z","message":{"role":"assistant","content":[],"stopReason":"aborted","timestamp":1793552687847,"errorMessage":"Operation aborted","durationMs":200}}
```

No assistant message mentioned the marker before the follow-up. After the follow-up the marker was
in the context: the model's thinking says “The steer marker says reply with STEER-MARK-9c02A … But
the newest instruction is BANANA”, then it replied `BANANA`. So the message was retained in the
transcript but never seen during the aborted turn.

Adapter view for this member: `journal-listing.json` is `[]` and `injected.missing` exists. The
journal was committed, so the adapter counted the batch as delivered — correctly, in the narrow
sense that `sendMessage` accepted it and the `custom_message` is on disk. It does **not** mean the
model saw it: there was no assistant message for that turn, and the process could sit there with
the message unseen until some later prompt.

## What surprised me

1. **The brief's premise about `pg.steer` was already false at HEAD.** `pg.steer` does not just
   inject into a running turn; it calls `abortTurn()` when busy (`src/loop.ts:799`). The platform
   row above cut a 60 s tool at 5.1 s. Any experiment that only uses platform `pg.steer` measures
   abort-before-steer, not pi's steer semantics.
2. **A steer's send return is not a delivery timestamp.** Native `sendMessage` returned in 0–1 ms
   with `isIdle=false`; the transcript entry appeared 54.9 s later, 1 ms after the tool result.
   Measuring adapter latency at the `sendMessage` call would report ~0 ms for a message the model
   did not see for a minute.
3. **Abort loses a still-queued native steer completely, not just from the transcript.** The marker
   was absent before and after a later user turn; nothing in the session file could be replayed.
   The same abort after an adapter-delivered marker gave `KEPT-BUT-UNSEEN` instead, because that
   marker had already been persisted as a `custom_message`. Delivery state therefore depends on
   whether the steer was drained before the abort, not just on whether it was accepted.
4. **The adapter's journal being empty is not proof the model saw anything.** For the
   `pg.steer`+`pg.abort` case the journal is empty and the marker is on disk, but the marker's run
   was aborted 200 ms after the marker entry and no assistant response was generated.

## Files

- `run.log` — driver's live log, including platform post times.
- `commands.log` — every `herdr`/`git`/`pi` command issued by the driver.
- `env.sh` — port, data/adapter/scratch dirs, model.
- `<case>/probe.jsonl` — probe send/abort/tool events with `epoch_ms`.
- `<case>/session.jsonl` — pi's own session file, copied before teardown.
- `<case>/timeline.txt` — key entries (tool call/result, custom_message, error assistant, marker assistant).
- `<case>/timeline-full.txt` — every entry from the first user prompt onward, raw JSON included.
- `<case>/summary.json` — derived ordering, marker rows, verdicts.
- `<case>/adapter-view/` — `journal/`, `journal-listing.json`, injected watermark or `.missing`.
- `<case>/pane.txt` — pane scrollback before the tab was closed.
- `final-panes.json`, `cleanup.json` — teardown evidence.
