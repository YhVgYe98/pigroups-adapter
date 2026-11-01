# Steer/abort experiment 20261101T170244Z

pi 1.4.0, adapter HEAD 48feef2a56e95a6b6279c387ac9f8a68d4f1cbf6, model deepseek/deepseek-flash.
Platform http://127.0.0.1:36691 (throwaway; pid in platform.pid).

| case | marker | steer entry timestamp | tool result timestamp | first assistant mention | immediate | after follow-up |
|---|---|---|---|---|---|---|
| e1-long-native | STEER-MARK-7f31 | 2026-11-01T17:03:49.881Z | 2026-11-01T17:03:49.880Z | 2026-11-01T17:03:50.468Z | SEEN | — |
| e1-short-native | STEER-MARK-7f31 | 2026-11-01T17:04:01.773Z | 2026-11-01T17:04:01.772Z | 2026-11-01T17:04:02.539Z | SEEN | — |
| e1-long-adapter | STEER-MARK-7f31A | 2026-11-01T17:04:13.196Z | 2026-11-01T17:04:13.146Z | 2026-11-01T17:04:14.399Z | SEEN | — |
| e2-native-steer-platform-abort | STEER-MARK-9c02 | — | 2026-11-01T17:04:26.038Z | — | LOST | LOST |
| e2-adapter-steer-then-abort | STEER-MARK-9c02A | 2026-11-01T17:04:47.846Z | 2026-11-01T17:04:47.796Z | 2026-11-01T17:04:58.357Z | KEPT-BUT-UNSEEN | SEEN |

See `report.md` for the verdicts with the verbatim JSONL and the two caveats (the adapter
aborts a busy member before injecting, and a native steer is not persisted until the tool returns).
Raw evidence is in each case directory: `probe.jsonl`, `session.jsonl`, `timeline.txt`,
`timeline-full.txt`, `summary.json`, `adapter-view/`, `pane.txt`. The archived driver is `driver.mjs`;
the probe extension is `steer-probe.ts`.
