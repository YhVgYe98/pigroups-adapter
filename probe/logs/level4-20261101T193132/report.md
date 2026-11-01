# Level 4 end-to-end run — verdict

Throwaway platform on 127.0.0.1:7911, one root started the way a human starts it
(`herdr pane split` + `herdr agent start`), one child created through `pg_spawn`,
briefed over a DM, terminated through `pg_terminate`.
Adapter `src/` was **not** modified. Evidence files are named after the journal.

## PASS

| claim | evidence |
|---|---|
| The root starts as a real member and its adapter loop runs | `herdr agent start root` → `"interactive_ready":true`; `GET /v1/members/m_d1becc` `last_seen_at` advances 1793532734180 → 1793532737197 in 3 s (`journal.md` §1.5) |
| `pg_spawn` creates the member | root transcript: `toolCall pg_spawn {"name":"alpha",…}` → `{"id":"m_635f7e","name":"alpha"}` in 15281 ms (`transcripts/root.md`); `GET /v1/tree` shows `alpha`, `parent_id m_d1becc` |
| …and a herdr pane with a live pi in it | new pane `wE:pX agent=pi status=working` in `herdr pane list`; alpha's own pi session file records tool results written after the spawn (`transcripts/alpha.md`) |
| The pane is the one `src/herdr.ts` made | `herdr.ts` passes `label = member name` to `agent start`; the fallback path (`pane send-text`) would not have produced `agent=pi`; `pane-split-root.json` / `agent-start-root.json` show the same envelope shape for the root (`"name":"root"`) |
| The briefing reached the child's **model** and it acted | child transcript: `INJECTED pigroups (message) [dm:m_635f7e_m_d1becc#1] root: You are alpha…` at 11:32:27.547, then `pg_say {"to":"g:m_d1becc",…}` → `{"conv":"g:m_d1becc","seq":1}` at 11:32:35.491 |
| The child's `pg_say` is visible through the human API | `GET /v1/messages?to=g:m_d1becc` (human token) → `{"sender_name":"alpha","body":"alpha here: received the brief and I'm in the group — standing by.","seq":1}` (`after-delete.txt`) |
| The per-member journal/watermark fix holds | `ADIR/journal/m_d1becc/`, `ADIR/journal/m_635f7e/` both exist (empty: batches committed); `ADIR/injected/m_d1becc.json` = `{"dm:…":6}`, `ADIR/injected/m_635f7e.json` = `{"dm:…":5}` — one shared directory, two different watermarks (`adapter-dir/`) |
| `pg_terminate` deletes the subtree | root transcript: `toolCall pg_terminate {"member":"m_635f7e"}` → `{"terminated":["m_635f7e"]}` (2 ms) |
| The platform reports the member gone | `GET /v1/members/m_635f7e` → `"status":"gone"`, `gone_reason":"deleted"`; `GET /v1/tree` lists only the root (`after-delete.txt`, `db-inspect.txt`) |
| The child's **process** is gone | `sys.terminated` receipt `delivered` (db); pane `wE:pX` ends with pi's `To resume this session: pi --session …` banner and a shell prompt; `herdr agent list` no longer has `alpha`; `ps` has no child pi (`after-delete.txt`) |
| the root is told the child is gone | root transcript nudge: `你的 1 个下级需要处理：- m_635f7e（m_635f7e）gone`; `pg_children` → `[]` |

## FAIL

1. **The root never sees `pg.report`.** There is no `pg_report` tool: the adapter registers
   `pg_children, pg_inspect, pg_abort, pg_steer, pg_say, pg_read, pg_spawn, pg_terminate,
   pg_whoami` and nothing else (`src/extension.ts:buildTools`). The child verified this at
   runtime with `searchTools("pg")` and reported over a DM instead (`transcripts/alpha.md`
   11:32:32.951). The platform's `controls` table contains exactly **one** row for the whole
   run — `sys.terminated` — so no `pg.report` was ever sent (`db-inspect.txt`).
   The adapter's own exit report cannot cover this either: `session_shutdown` →
   `reportExiting` starts with `GET /v1/whoami`, and `src/http.ts:20-23` answers **410
   `member_gone`** for a `gone` member, so the catch swallows it. Delete-then-report is
   impossible by construction.
2. **The child's pane is not gone.** After the delete `herdr pane list` still shows
   `wE:pX agent=- status=unknown`, title `yang@yangPC:/tmp/pigroups-l4-scratch…`: the pane
   returned to a shell prompt and stayed in the user's tab. Nothing in `src/` calls
   `Herdr.close` (`grep -rn 'herdr.close\|\.close(' src/` → no hits), and `AdapterLoop.terminate`
   only calls `pg.deleteMember`. `herdr.ts` implements `close()` that no one uses.

## BLOCKED

Nothing in the scenario was un-attemptable. Three *described* instruments did not exist as
described; each was replaced with the documented one, and that is recorded here rather than
worked around silently:

- `GET /v1/messages?all=true` with `Bearer adm` → 401 `invalid_token`; with a human token →
  400 `to is required`. `adm` authenticates only `POST /v1/humans`; reads need the returned
  human token plus a conversation id. There is no all-messages endpoint (`GET /v1/conversations`
  is the human index, and it omits a group once its last child is gone).
- `GET /v1/control?all=true` → **500 internal_error**, see SURPRISE 2.
- `herdr agent read <pane> --lines N` on a **working** agent → `agent_not_idle`; and
  `herdr agent wait` on an exited agent → `agent_not_found`. `src/herdr.ts:read()` uses
  exactly the failing form (default `--source recent`), so `Herdr.read` cannot be used as a
  diagnostic while a child works — and it has no caller today.

## SURPRISE

1. **Stale owed-reply marker survives termination.** After `pg_terminate`, the root's own
   `pg_whoami` says `"owed":["dm:m_635f7e_m_d1becc"],"nudges":{…:3}` and `pg_say` to the
   dead peer fails `member is gone` (`transcripts/root-live2.md`). The adapter nudged the root
   about it 3 times (nudgeMax) and then stopped, but the marker never clears: `AdapterLoop.say`
   is the only place that clears an obligation, and it clears *after* a successful send.
   `terminate()` does not touch `this.obligations`. This is a delete-path bug, not a platform one.
2. **`GET /v1/control?all=true` is broken** (platform, not adapter): `allControlPage` does
   `JSON.parse(control.to_json)` and the `sys.terminated` row stores the bare id `m_635f7e`
   → `SyntaxError: Unexpected token 'm', "m_635f7e" is not valid JSON` at
   `src/routes/control.ts:68` (stack in `platform.log`). A human therefore cannot audit
   instructions for the one case where they matter most — right after a delete.
3. **The child-gone telemetry nudge shows the id twice**: `m_635f7e（m_635f7e）gone`. Telemetry
   had no `name` entry for the child, so `terminate()`'s `known?.name ?? id` fell back to the id.
4. **The scratch panes were not isolated from the user's pi setup.** `pi -e …/extension.ts`
   inherited the global extension set: `pi-straw-boss` and `pi-intercom` loaded in the root and
   the child. The root escalated surprise 1 over intercom to the user's tower (`call_tower`),
   the tower relayed it into the user's main session 01a188bd, and `pi-straw-boss` ran
   `balance.mjs after-close wE:pX` when the child exited, re-balancing the *user's* tab.
   A clean probe needs `-ne` (no extensions) plus only the adapter, or a scratch `PI_*` config.
5. **The root deleted the child by itself**, to break an ack ping-pong
   (`transcripts/root.md` 11:33:00.071 "Best: … terminate alpha"). The delete step still
   measured exactly as designed, but it happened because the model chose it, not because the
   prompt asked for it — the ack ping-pong was created by the owed-reply nudge.
6. **The group conversation vanishes from the human index after the delete.** `GET /v1/conversations`
   lists only `dm:…`; the group message is still readable at `to=g:m_d1becc`. Per §3.3 this is
   correct (a group exists only while it has children), but it means "did anyone speak in the
   group?" is unanswerable from the conversation list after cleanup.

## Not observed / limits of this run

- The child's exact pid was never captured while it was alive; "process running" rests on
  herdr's `agent=pi status=working`, the child's own session file growing, and the exit banner.
  The child's herdr agent **label** was not re-read with `herdr agent list` before it exited
  (it had already exited when I first listed agents) — the `agent start … alpha` call is
  inferred from `herdr.ts` (`label = name`) and from the root's analogous envelope.
- The `pg.report` control path was exercised only negatively (it was never emitted).
- Restart/replay behaviour (journal replay, watermark across restart) was not part of this level.
