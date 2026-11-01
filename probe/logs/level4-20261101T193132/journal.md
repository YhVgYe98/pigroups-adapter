# Level 4 end-to-end run — 2026-11-01T19:31:35+08:00

Adapter: /home/yang/Documents/pigroups-adapter (src/herdr.ts is the code under test)
Platform: "/home/yang/Documents/PiGroups"
pi: 1.4.0 / herdr: herdr 0.9.5
PIGROUPS_DATA=/tmp/pigroups-l4-data.t2CWgs
PIGROUPS_ADAPTER_DIR=/tmp/pigroups-l4-adapter.QTmqw9
scratch cwd=/tmp/pigroups-l4-scratch.gmWkwt
port=7911

Pre-existing panes (must be the only ones left after cleanup): wD:p1E, wE:pB, wE:p1

## Setup

- `cd "$PG"` failed: the env.sh line had literal quotes in PG. Fixed env.sh, no platform started. exit=1
- `cd $PG && PIGROUPS_ADMIN_TOKEN=adm PORT=$PORT PIGROUPS_DATA=$PIGROUPS_DATA node src/main.ts > $EVID/platform.log 2>&1 &` -> pid 36532, exit=0
  - line that mattered: `listening on 7911`

- `curl -s -X POST $PIGROUPS_URL/v1/bootstrap -d '{"name":"root"}'` -> exit=0, member id=m_d1becc
  - raw: `{"member":{"id":"m_d1becc","name":"root","parent_id":null,"status":"alive","is_root":true,"child_count":0,"groups":[],"last_seen_at":null,"created_at":1793532716983},"token":"pgt_REDACTED","server_version":"0.1.0"}`
- `herdr pane split --direction down --no-focus --cwd $SCRATCH --env PIGROUPS_URL=... --env PIGROUPS_TOKEN=$ROOT_TOKEN --env PIGROUPS_ADAPTER_DIR=$ADIR --env PIGROUPS_SPAWN_CMD=...` -> exit=0, pane_id=wE:pW (`pane_info`)
- `herdr agent start root --kind pi --pane wE:pW --timeout 60000 -- -e $ADAPTER/src/extension.ts --model deepseek/deepseek-flash` -> exit=0, result.type=agent_started, interactive_ready=true

- root adapter is polling: `GET /v1/members/$ROOT_ID` last_seen_at 1793532734180 -> 1793532737197 3s later (adapter's long-poll touches it). ADIR still empty (root has no parent, so no brief/watermark file yet).
- `herdr agent prompt $ROOT_PANE '<spawn alpha brief>' --wait --timeout 300000` -> exit=, 24s, result.type=agent_prompted

- Brief said the human API takes `Bearer adm`. It does not: `GET /v1/messages?all=true` with adm -> 401 invalid_token. The doc ($PG/docs/设计说明.md §10.2) says `POST /v1/humans` is the endpoint that authenticates with the admin token, and the returned human token is what reads everything. Did that: `POST /v1/humans {"name":"probe-human"}` -> exit=0, human id=h_ba5ed4.

- `GET /v1/messages?all=true` with the human token -> 400 `to is required`. There is no all-messages endpoint either: the doc has humans list `GET /v1/conversations` and then read each one with `to=`. Used that.

## Commands and results, in order

Every command below was run from this directory's `env.sh` (exports the vars).
Exit code is the shell's; "line that mattered" is copied from the output, not paraphrased.

### 1. Platform

| # | command | exit | line that mattered |
|---|---|---|---|
| 1.1 | `PIGROUPS_ADMIN_TOKEN=adm PORT=7911 PIGROUPS_DATA=$PIGROUPS_DATA node src/main.ts &` (cwd `$PG`) | 0 | `listening on 7911` (platform.log) |
| 1.2 | `curl -s $PIGROUPS_URL/v1/health` | 0 | `{"status":"ok","version":"0.1.0",...}` |
| 1.3 | `curl -s -X POST $PIGROUPS_URL/v1/bootstrap -H 'Content-Type: application/json' -d '{"name":"root"}'` | 0 | `member.id=m_d1becc`, token `pgt_f882f9…` (full value in env.sh, throwaway) |
| 1.4 | `GET /v1/whoami` with the root token | 0 | `"is_root":true,"child_count":0` |
| 1.5 | `GET /v1/members/$ROOT_ID` twice, 3 s apart | 0 | `last_seen_at 1793532734180 -> 1793532737197` — the adapter's long-poll is running in the root |
| 1.6 | `POST /v1/humans {"name":"probe-human"}` with `Bearer adm` | 0 | `{"human":{"id":"h_ba5ed4"...},"token":"pgt_71627c…"}` |

Note (brief vs machine): the brief said the human API reads with `Authorization: Bearer adm`.
It does not — `GET /v1/messages?all=true` with `adm` answers 401 `invalid_token`, and with the
human token it answers 400 `to is required` (there is no all-messages endpoint). The doc
(`$PG/docs/设计说明.md` §10.2/§10.4) is right: `adm` authenticates **only** `POST /v1/humans`;
reads use the human token and a conversation id. I used that.

### 2. Root via herdr, the way a human would

| # | command | exit | line that mattered |
|---|---|---|---|
| 2.1 | `herdr pane split --direction down --no-focus --cwd $SCRATCH --env PIGROUPS_URL=… --env PIGROUPS_TOKEN=… --env PIGROUPS_ADAPTER_DIR=$ADIR --env 'PIGROUPS_SPAWN_CMD=pi -e …/src/extension.ts --model deepseek/deepseek-flash'` | 0 | `"pane_id":"wE:pW"` (pane-split-root.json) |
| 2.2 | `herdr agent start root --kind pi --pane wE:pW --timeout 60000 -- -e …/src/extension.ts --model deepseek/deepseek-flash` | 0 | `"name":"root","interactive_ready":true,"agent_status":"idle"` (agent-start-root.json) |
| 2.3 | `herdr agent wait wE:pW --until idle --timeout 120000` | 0 | `"agent_status":"idle"` |
| 2.4 | `herdr agent read wE:pW --lines 60` | 0 | pi 1.4.0 banner, `[Extensions] … extension.ts …` (root-pane-initial.txt) |

The root's ADIR stayed empty at this point — correct for a root: it has no parent, so no brief
and no watermark to write. The absence of files is not a failure of the loop; 1.5 proves polling.

### 3. Ask the root for one child

| # | command | exit | line that mattered |
|---|---|---|---|
| 3.1 | `herdr agent prompt wE:pW "Call the pg_spawn tool: name the member 'alpha' and give it this brief — 'You are alpha. Call pg_say … then call pg_report …' Then stop." --wait --timeout 300000` | 0 | 24 s, `"type":"agent_prompted","agent_status":"idle"` (prompt-root-spawn.json) |
| 3.2 | root transcript: `toolCall pg_spawn {"name":"alpha","brief":"You are alpha. Call pg_say …"}` → result | 0 | `{"id":"m_635f7e","name":"alpha"}`, `durationMs 15281` (transcripts/root.md) |
| 3.3 | `GET /v1/tree` (root token) | 0 | `{"id":"m_635f7e","name":"alpha","parent_id":"m_d1becc","child_count":0}` |
| 3.4 | `herdr pane list` | 0 | new pane `wE:pX agent=pi status=working`, title `π - pigroups-l4-scratch.gmWkwt` |
| 3.5 | `find $ADIR` | 0 | `journal/m_d1becc`, `journal/m_635f7e`, `injected/m_d1becc.json`, `injected/m_635f7e.json` — two members, two journals, two watermarks |

### 4. Verification of the child

| # | command | exit | line that mattered |
|---|---|---|---|
| 4.1 | `herdr agent read wE:pX --lines 80` **while it was working** | **1** | `{"error":{"code":"agent_not_idle","message":"cannot read 80 lines while wE:pX is working…"}}` — see finding S3 |
| 4.2 | `herdr agent read wE:pX --source visible` | 0 | live TUI: `{"conv":"dm:m_635f7e_m_d1becc","seq":6}` + "Closing ack sent" (alpha-visible-working.txt) |
| 4.3 | `herdr agent wait wE:pX --until idle --timeout 180000` (after the delete had run) | **1** | `{"error":{"code":"agent_not_found","message":"agent target wE:pX not found"}}` — the child's pi had already exited |
| 4.4 | `herdr pane read wE:pX --source recent --lines 120` | 0 | end of the child's TUI, then `To resume this session: pi --session 01a196e1-de2d-…` and a shell prompt (alpha-pane-recent-after-exit.txt) |
| 4.5 | child transcript: first entry | — | `INJECTED pigroups (message) [dm:m_635f7e_m_d1becc#1] root: You are alpha. Call pg_say …` (transcripts/alpha.md) |
| 4.6 | child transcript: its tool call after the brief | — | `pg_say {"to":"g:m_d1becc","text":"alpha here: received the brief and I'm in the group — standing by."}` → `{"conv":"g:m_d1becc","seq":1}` |
| 4.7 | `GET /v1/messages?to=g:m_d1becc&limit=50` with the human token | 0 | `{"sender_name":"alpha","body":"alpha here: received the brief and I'm in the group — standing by.","seq":1}` |
| 4.8 | child transcript: the requested `pg_report` | — | `searchTools("pg")` returns 9 tools, no `pg_report`; the model writes "no pg_report tool exists in this adapter … this DM is my report to you" |
| 4.9 | root transcript after the DM | — | `INJECTED (message) [dm:…#2] alpha: … no pg_report tool exists …`; the root's `pg_say` → `seq:3` |
| 4.10 | root's own `pg_whoami` after the delete (asked through the pane) | 0 | `"adapter":{"owed":["dm:m_635f7e_m_d1becc"],"nudges":{"dm:m_635f7e_m_d1becc":3}}` (prompt-root-verify.json, transcripts/root-live2.md) |

`GET /v1/members` with `adm` → 401 `invalid_token`; there is no list endpoint for members
(the tree is the list). Alpha's row was read with `GET /v1/members/m_635f7e`.

### 5. Delete

| # | command | exit | line that mattered |
|---|---|---|---|
| 5.1 | root transcript: `toolCall pg_terminate {"member":"m_635f7e"}` | — | result `{"terminated":["m_635f7e"]}` in 2 ms — the root did this itself, no human DELETE was needed |
| 5.2 | `GET /v1/members/m_635f7e` (root token) | 0 | `"status":"gone"`, `gone_at 1793532780073`, `gone_reason deleted` (db-inspect.txt) |
| 5.3 | `GET /v1/tree` | 0 | only `m_d1becc` remains, `child_count:0` |
| 5.4 | platform DB (read-only): controls table | 0 | exactly one row: `sys.terminated` `to=m_635f7e`, receipt `delivered`, `terminated_by m_d1becc`. **No `pg.report` row anywhere.** |
| 5.5 | herdr pane list after the delete | 0 | `wE:pX agent=- status=unknown title=yang@yangPC:/tmp/…` — the **pane still exists**, at a shell prompt |
| 5.6 | `herdr agent list` after the delete | 0 | agents: `tower-we`, main, `root` — **alpha is gone from herdr's agent list** |
| 5.7 | `ps -eo pid,ppid,etime,args` after the delete | 0 | `36710 … pi` (root), `36532 … node src/main.ts` (platform), `3429`/`3540` (user's sessions) — **no alpha pi** |

The child's exit was orderly: the pane's last line is pi's `To resume this session: …` banner,
no error, and its session file stops at 11:32:55 (before the delete at 11:33:00).
The adapter's shutdown path is the only thing that calls `ctx.shutdown()`.

### 6. Cleanup

| # | command | exit | line that mattered |
|---|---|---|---|
| 6.1 | `cp -r $ADIR/journal $ADIR/injected $EVID/adapter-dir/` | 0 | two watermark files with different seqs (5 and 6), journals empty because every batch was committed |
| 6.2 | `herdr pane close wE:pW` (root) | 0 | `{"type":"ok"}` |
| 6.3 | `herdr pane close wE:pX` (alpha's leftover shell pane) | 0 | `{"type":"ok"}` |
| 6.4 | `herdr pane list` | 0 | `wD:p1E wE:pB wE:p1` — exactly the three panes that existed before the run |
| 6.5 | `kill $(cat platform.pid)` | 0 | pid gone; `ss -ltnp \| grep :7911` → none |
| 6.6 | `ps -eo pid,ppid,etime,args` | 0 | only the user's two pi processes (3429 tower, 3540 main); no root pi, no child pi, no `node src/main.ts` |
| 6.7 | `rm -rf $PIGROUPS_DATA $ADIR $SCRATCH` | 0 | all three temp dirs removed (not committed) |

`git status --short` before the commit shows pre-existing edits to `src/loop.ts`,
`src/pgclient.ts`, `test/obligation.test.ts` that were **not** made by this run; only
`probe/logs/level4-20261101T193132/` is added.

## Verdict

See `report.md` for PASS / FAIL / BLOCKED / SURPRISE with the evidence line for each.
Short form: spawn → briefing → act → group message → delete → process exit all worked;
"the root sees pg.report" failed (no such tool, and the exit report is 410-blocked after
a delete); "the child's pane is gone" failed (nothing closes it); and the delete path leaves
a stale owed-reply marker on the parent that no API call can clear.
