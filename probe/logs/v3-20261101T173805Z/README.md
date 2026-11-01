# v3 real-machine verification 20261101T174208Z

pi 1.4.0, adapter HEAD 8d21f37c8dd1543b315a9be80e0b6fc24a1cf31d, model deepseek/deepseek-flash.
Platform http://127.0.0.1:33283 (throwaway; pid in platform.pid). Delivery window 5000 ms in every live case.

| case | verdict | key timestamp | detail | detail 2 | detail 3 |
|---|---|---|---|---|---|
| A-steer-midtool | PASS | 2026-11-01T17:42:23.592Z | 2026-11-01T17:43:13.955Z | 1 ms | 2026-11-01T17:43:14.739Z |
| B-abort-requeue | PASS | 2026-11-01T17:43:32.148Z | 1 | 1 | yes |
| C-members-schedule | PASS | total 6 / matched 6 | self=self parent=parent child=child sibling=sibling | 18916 ms | 2026-11-01T17:44:02.392Z |
| D-skills-banner | PASS | council-mode, pi-intercom, pi-subagents, pigroups-message, pigroups-org, workflow-authoring, workflow-patterns | — | — | — |

Raw evidence per case: `probe.jsonl`, `adapter-watch.jsonl`, `session.jsonl`, `timeline.txt`, `summary.json`, `pane.txt`.

Negative control for B (`B-negative-control-no-requeue/`): the same abort sequence against a scratch
adapter copy with `requeueLastDelivered()` removed; the marker is LOST (0 custom messages, 0 mentions),
matching `probe/logs/steer-20261101T170244Z/e2-native-steer-platform-abort`.

Mutation sweep: `mutation/results.txt` (12 mutations, every one killed by a named test).
Full report: `report.md`.
