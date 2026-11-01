# The commands behind this evidence directory

**Reconstructed after the run** from `run.log`, `agent-start-root.json`, the recorded
JSON/txt files in this directory, and the prompts visible in `root-pane-after-delete.txt`
(lines 31–32 and 58). The original driver script lived in `/tmp` and was not committed;
the values that the run printed are given below. Tokens are disposable and not recorded.

Values the run printed:

```
PORT=40629              # run.log
ROOT_ID=m_dcfea5        # run.log, bootstrap.json
ROOT_PANE=wE:p0         # run.log, pane-split-root.json
CHILD_ID=m_6713a6       # run.log, root-pane-after-delete.txt
CHILD_PANE=wE:p11       # run.log, wait-child.json
SCRATCH=/tmp/pigroups-fix-scratch.nnvzBf   # pane-split-root.json (cwd)
MODEL=deepseek/deepseek-flash              # agent-start-root.json (argv)
```

```bash
ADAPTER=/home/yang/Documents/pigroups-adapter
PG=/home/yang/Documents/PiGroups
PORT=40629
MODEL=deepseek/deepseek-flash
DATA=$(mktemp -d)
ADIR=$(mktemp -d)
SCRATCH=$(mktemp -d)
SPAWN_CMD="pi -ne -e $ADAPTER/src/extension.ts --model $MODEL"

# 1. throwaway platform                                          -> platform.log
(cd "$PG" && PIGROUPS_ADMIN_TOKEN=adm PORT=$PORT PIGROUPS_DATA=$DATA node src/main.ts) &
PLATFORM_PID=$!
until curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null; do sleep 0.2; done

# 2. root member (bootstrap is usable once)                      -> bootstrap.json
ROOT=$(curl -sX POST "http://127.0.0.1:$PORT/v1/bootstrap" \
  -H 'content-type: application/json' -d '{"name":"root"}')
ROOT_ID=$(printf '%s' "$ROOT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).member.id))')
ROOT_TOKEN=$(printf '%s' "$ROOT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')

# 3. root pane: the environment rides on pane split, not agent start
ROOT_PANE=$(herdr pane split --direction down --no-focus --cwd "$SCRATCH" \
  --env PIGROUPS_URL="http://127.0.0.1:$PORT" \
  --env PIGROUPS_TOKEN="$ROOT_TOKEN" \
  --env PIGROUPS_ADAPTER_DIR="$ADIR" \
  --env "PIGROUPS_SPAWN_CMD=$SPAWN_CMD" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).pane.pane_id))')
#                                                               -> pane-split-root.json

# 4. start the root agent; -ne keeps the user's global extensions out
herdr agent start root --kind pi --pane "$ROOT_PANE" --timeout 120000 \
  -- -ne -e "$ADAPTER/src/extension.ts" --model "$MODEL"        # -> agent-start-root.json
herdr agent wait "$ROOT_PANE" --until idle --timeout 120000     # -> wait-root.json

# 5. make the root spawn the child
herdr agent prompt "$ROOT_PANE" \
  "Call the pg_spawn tool exactly once: name the member 'probe-child' and give it this brief — 'You are probe-child. Wait quietly; do not send any messages.' Then stop. Do not call pg_terminate in this turn." \
  --wait --timeout 300000                                       # -> prompt-spawn.json
CHILD_PANE=wE:p11
herdr agent wait "$CHILD_PANE" --until idle --timeout 120000    # -> wait-child.json
herdr pane list                                                # -> panes-after-spawn.json
herdr pane get "$CHILD_PANE"                                   # -> child-pane-before-delete.json

# 6. make the root delete it (the path under test)
herdr agent prompt "$ROOT_PANE" \
  "Call the pg_terminate tool exactly once with member \"$CHILD_ID\". Then stop. Do not send any message." \
  --wait --timeout 120000                                       # -> prompt-terminate.json

# 7. what has to be true afterwards
curl -s "http://127.0.0.1:$PORT/v1/members/$CHILD_ID" -H "Authorization: Bearer $ROOT_TOKEN" \
                                                                # -> member-after-delete.json
herdr pane list                                                # -> panes-after-delete.json
herdr agent list                                               # -> agents-after-delete.json
ps aux                                                         # -> ps-after-delete.txt
herdr agent read "$ROOT_PANE" --lines 200                      # -> root-pane-after-delete.txt

# 8. cleanup
herdr pane close "$ROOT_PANE"
kill "$PLATFORM_PID"
rm -rf "$DATA" "$ADIR" "$SCRATCH"
```

`run.log` was written by the driver with `[l4-fix]` lines; its last line is
`PASS: child pane and agent are gone after pg_terminate`.

What this run did **not** capture: the child's own `sys.terminated` receipt or transcript.
The pane is closed immediately after the platform commits the `DELETE`, so it is possible
that the close preempts the child's pi before it consumes the notice and writes its
session. That is recorded as a known limit in `docs/handoff.md` §7; see `report.md` for
the run's own conclusions.
