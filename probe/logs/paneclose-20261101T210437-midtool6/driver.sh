#!/usr/bin/env bash
# Real-machine verification of fix A (herdr: wait for the pane's agent to exit before close).
#
# Drives a throwaway platform + a root pi in a herdr pane. The root spawns a child
# through pg_spawn, the child speaks, then the root deletes it through pg_terminate.
# The driver samples the child pane (herdr) and the child pi process (/proc) at high
# rate so the shutdown-before-close ordering is observed, not inferred.
#
# Every artefact lands in this directory; nothing outside it is modified except the
# throwaway /tmp dirs (removed at the end) and the herdr panes (closed at the end).
set -uo pipefail

OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stamp() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
say() { printf '[paneclose] %s %s\n' "$(stamp)" "$*" | tee -a "$OUT/run.txt"; }
die() { say "FATAL: $*"; exit 2; }
now_ms() { date +%s%3N; }

ADAPTER=/home/yang/Documents/pigroups-adapter
PG=/home/yang/Documents/PiGroups
URL=http://127.0.0.1:40777
MODEL=deepseek/deepseek-flash
PORT=40777

DATA=$(mktemp -d /tmp/pgpc-data.XXXXXX)
ADIR=$(mktemp -d /tmp/pgpc-adir.XXXXXX)
SCRATCH=$(mktemp -d /tmp/pgpc-scratch.XXXXXX)
ROOTSESS=$(mktemp -d /tmp/pgpc-rootsess.XXXXXX)
CHILDSESS=$(mktemp -d /tmp/pgpc-childsess.XXXXXX)
# CHILD_TASK=idle   : the child answers the brief, then goes idle; delete it there.
# CHILD_TASK=midtool: after the child is idle, the root tells it (pg_say) to run one
#                     `bash sleep 40`; the root deletes it while that tool is running,
#                     so the child has to end a live tool call during its own shutdown.
CHILD_TASK="${CHILD_TASK:-idle}"
# How long the mid-tool variant's bash call runs. 40 s leaves the child in the tool for
# the whole 5 s close bound; 6 s lets the tool end first, which separates "the close cut
# a live child" from "pi waits for the tool, then exits".
CHILD_TOOL_SLEEP="${CHILD_TOOL_SLEEP:-40}"
SPAWN_CMD="pi -ne -e $ADAPTER/src/extension.ts --model $MODEL --session-dir $CHILDSESS --name probe-child"

PLATFORM_PID=""
ROOT_PANE=""
CHILD_PANE=""
SAMPLERS=()

cleanup() {
  local status=$?
  set +e
  say "== cleanup =="
  for pid in "${SAMPLERS[@]:-}"; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null; done
  if [[ -n "${CHILD_SESSION:-}" && -f "$CHILD_SESSION" && ! -f "$OUT/child-session.jsonl" ]]; then
    cp "$CHILD_SESSION" "$OUT/child-session.jsonl"
    say "preserved child session in cleanup"
  fi
  for pane in "$CHILD_PANE" "$ROOT_PANE"; do
    if [[ -n "$pane" ]]; then
      herdr pane close "$pane" >/dev/null 2>&1
      say "closed pane $pane (exit $?)"
    fi
  done
  if [[ -n "$PLATFORM_PID" ]]; then
    kill "$PLATFORM_PID" 2>/dev/null
    wait "$PLATFORM_PID" 2>/dev/null
    say "platform stopped (pid $PLATFORM_PID)"
  fi
  rm -rf "$DATA" "$ADIR" "$SCRATCH" "$ROOTSESS" "$CHILDSESS"
  herdr pane list > "$OUT/panes-final.json" 2>&1
  say "final panes: $(grep -o '"pane_id":"[^"]*"' "$OUT/panes-final.json" | cut -d'"' -f4 | tr '\n' ' ')"
  say "driver exit $status"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------- helpers

pick() { # dotted.path  (reads JSON on stdin; prints "" when missing)
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let j; try { j = JSON.parse(s); } catch { return console.log(""); }
      for (const part of process.argv[1].split(".")) { if (j == null) break; j = j[part]; }
      console.log(j === undefined || j === null ? "" : typeof j === "object" ? JSON.stringify(j) : String(j));
    });' "$1"
}

api_get() { # path token
  curl -s "$URL$1" -H "Authorization: Bearer $2"
}

say "== 0. baseline =="
{ echo "commit: $(git -C "$ADAPTER" rev-parse HEAD)";
  echo "herdr.ts sha256: $(sha256sum "$ADAPTER/src/herdr.ts")";
  echo "pi: $(pi --version 2>&1)"; echo "herdr: $(herdr --version 2>&1 | head -1)"; } > "$OUT/tree.txt"
git -C "$ADAPTER" status --porcelain >> "$OUT/tree.txt"
herdr pane list > "$OUT/panes-baseline.json"
say "baseline panes: $(grep -o '"pane_id":"[^"]*"' "$OUT/panes-baseline.json" | cut -d'"' -f4 | tr '\n' ' ')"
say "commit $(git -C "$ADAPTER" rev-parse --short HEAD), herdr.ts $(sha256sum "$ADAPTER/src/herdr.ts" | cut -c1-16)"

say "== 1. throwaway platform =="
( cd "$PG" && PIGROUPS_ADMIN_TOKEN=adm PORT=$PORT PIGROUPS_DATA=$DATA node src/main.ts ) > "$OUT/platform.txt" 2>&1 &
PLATFORM_PID=$!
for _ in $(seq 1 100); do curl -sf "$URL/v1/health" >/dev/null && break; sleep 0.1; done
curl -sf "$URL/v1/health" >/dev/null || die "platform did not become healthy"
say "platform pid $PLATFORM_PID healthy at $URL (data $DATA)"

say "== 2. root member (bootstrap, once) =="
ROOT=$(curl -sX POST "$URL/v1/bootstrap" -H 'content-type: application/json' -d '{"name":"root"}')
printf '%s' "$ROOT" > "$OUT/bootstrap.json"
ROOT_ID=$(printf '%s' "$ROOT" | pick member.id)
ROOT_TOKEN=$(printf '%s' "$ROOT" | pick token)
[[ -n "$ROOT_ID" && -n "$ROOT_TOKEN" ]] || die "bootstrap failed: $ROOT"
say "root member $ROOT_ID"

HUMAN=$(curl -sX POST "$URL/v1/humans" -H 'Authorization: Bearer adm' -H 'content-type: application/json' -d '{"name":"paneclose-probe"}')
HUMAN_TOKEN=$(printf '%s' "$HUMAN" | pick token)
[[ -n "$HUMAN_TOKEN" ]] || die "human token failed: $HUMAN"

say "== 3. root pane (env rides on pane split) =="
SPLIT=$(herdr pane split --direction down --no-focus --cwd "$SCRATCH" \
  --env "PIGROUPS_URL=$URL" \
  --env "PIGROUPS_TOKEN=$ROOT_TOKEN" \
  --env "PIGROUPS_ADAPTER_DIR=$ADIR" \
  --env "PIGROUPS_SPAWN_CMD=$SPAWN_CMD")
printf '%s\n' "$SPLIT" > "$OUT/pane-split-root.json"
ROOT_PANE=$(printf '%s' "$SPLIT" | node -e '
  let s=""; process.stdin.on("data",(d)=>s+=d).on("end",()=>{
    const walk=(v)=>{ if(v&&typeof v==="object"){ if(typeof v.pane_id==="string")return v.pane_id; for(const k of Object.keys(v)){const r=walk(v[k]); if(r)return r;} } };
    console.log(walk(JSON.parse(s)) ?? ""); });')
[[ -n "$ROOT_PANE" ]] || die "pane split gave no pane id: $SPLIT"
say "root pane $ROOT_PANE"

herdr agent start root-pc --kind pi --pane "$ROOT_PANE" --timeout 180000 \
  -- -ne -e "$ADAPTER/src/extension.ts" --model "$MODEL" --session-dir "$ROOTSESS" \
  > "$OUT/agent-start-root.json" 2>&1
say "agent start root -> $(head -c 200 "$OUT/agent-start-root.json")"
herdr agent wait "$ROOT_PANE" --until idle --timeout 180000 > "$OUT/wait-root.json" 2>&1
say "root idle: $(cat "$OUT/wait-root.json" | head -c 200)"

say "== 4. root spawns the child =="
BRIEF="You are probe-child. Do exactly this and nothing else: call the pg_say tool once with to=g:$ROOT_ID and text=probe-child here. Then stop."
PROMPT_SPAWN="Call the pg_spawn tool exactly once with name=probe-child and this brief: \"$BRIEF\" Then stop."
say "child task: $CHILD_TASK"
say "prompt(spawn): $PROMPT_SPAWN"
herdr agent prompt "$ROOT_PANE" "$PROMPT_SPAWN" --wait --timeout 300000 > "$OUT/prompt-spawn.json" 2>&1
TA_SPAWN=$(now_ms)
say "spawn turn settled at $TA_SPAWN ($(stamp)): $(head -c 200 "$OUT/prompt-spawn.json")"

say "== 5. identify the child (platform tree + pane diff) =="
CHILD_ID=""
for _ in $(seq 1 100); do
  TREE=$(api_get /v1/tree "$ROOT_TOKEN")
  CHILD_ID=$(printf '%s' "$TREE" | node -e '
    let s=""; process.stdin.on("data",(d)=>s+=d).on("end",()=>{
      const j=JSON.parse(s); const n=(j.nodes??[]).find((x)=>x.parent_id!==null);
      console.log(n?n.id:""); });')
  [[ -n "$CHILD_ID" ]] && break
  sleep 0.2
done
[[ -n "$CHILD_ID" ]] || die "platform tree never showed a child"
printf '%s\n' "$TREE" > "$OUT/tree-after-spawn.json"
say "child member $CHILD_ID"

herdr pane list > "$OUT/panes-after-spawn.json"
CHILD_PANE=$(node -e '
  const fs=require("node:fs");
  const before=new Set(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).result.panes.map(p=>p.pane_id));
  const now=JSON.parse(fs.readFileSync(process.argv[2],"utf8")).result.panes.map(p=>p.pane_id);
  console.log(now.filter(p=>!before.has(p)&&p!==process.argv[3]).join(" "));
' "$OUT/panes-baseline.json" "$OUT/panes-after-spawn.json" "$ROOT_PANE")
say "new panes vs baseline: '$CHILD_PANE'"
CHILD_PANE=$(printf '%s' "$CHILD_PANE" | awk '{print $1}')
[[ -n "$CHILD_PANE" ]] || die "cannot identify the child pane"
herdr pane get "$CHILD_PANE" > "$OUT/child-pane-before-terminate.json"
herdr pane process-info --pane "$CHILD_PANE" > "$OUT/child-process-info.json" 2>&1
say "child pane $CHILD_PANE: $(grep -o '"agent":"[^"]*"\|"agent_status":"[^"]*"' "$OUT/child-pane-before-terminate.json" | tr '\n' ' ')"

# pi rewrites its own argv to "pi", so ps/grep cannot find it by flags. The pane's
# foreground process is the agent; identify it by the environment herdr and the
# adapter gave that process: HERDR_PANE_ID names the pane, PIGROUPS_TOKEN is the
# child's token (different from the root's), PIGROUPS_URL is the probe platform.
CPID=""
PANE_ENV=""
for _ in $(seq 1 50); do
  herdr pane process-info --pane "$CHILD_PANE" > "$OUT/child-process-info-idle.json"
  CAND=$(cat "$OUT/child-process-info-idle.json" | node -e '
    let s=""; process.stdin.on("data",(d)=>s+=d).on("end",()=>{
      const j=JSON.parse(s); const ps=j.result?.process_info?.foreground_processes ?? [];
      console.log(ps.length===1?String(ps[0].pid):""); });')
  if [[ -n "$CAND" && -r "/proc/$CAND/environ" ]]; then
    PANE_ENV=$(tr '\0' '\n' < "/proc/$CAND/environ")
    if printf '%s\n' "$PANE_ENV" | grep -qx "HERDR_PANE_ID=$CHILD_PANE" \
      && printf '%s\n' "$PANE_ENV" | grep -qx "PIGROUPS_URL=$URL" \
      && ! printf '%s\n' "$PANE_ENV" | grep -qx "PIGROUPS_TOKEN=$ROOT_TOKEN"; then
      CPID=$CAND; break
    fi
  fi
  sleep 0.2
done
[[ -n "$CPID" ]] || die "cannot identify the child pi process (process-info: $(cat "$OUT/child-process-info-idle.json"))"
printf '%s\n' "$PANE_ENV" | grep -E '^(HERDR_PANE_ID|PIGROUPS_URL|PIGROUPS_SPAWN_CMD)=' > "$OUT/child-process-identity.txt"
printf 'PIGROUPS_TOKEN matches root token: %s\n' "$(printf '%s\n' "$PANE_ENV" | grep -qx "PIGROUPS_TOKEN=$ROOT_TOKEN" && echo yes || echo no)" >> "$OUT/child-process-identity.txt"
say "child pi pid $CPID is the pane's foreground process, HERDR_PANE_ID=$CHILD_PANE, token != root"
cat "$OUT/child-process-identity.txt"

say "== 6. wait until the child is genuinely running and has spoken =="
CHILD_SESSION=""
for _ in $(seq 1 300); do
  CHILD_SESSION=$(find "$CHILDSESS" -name '*.jsonl' 2>/dev/null | head -1)
  if [[ -n "$CHILD_SESSION" ]] && grep -q '"toolName":"pg_say"' "$CHILD_SESSION" 2>/dev/null; then break; fi
  sleep 0.3
done
[[ -n "$CHILD_SESSION" ]] || die "no child session file under $CHILDSESS"
say "child session $CHILD_SESSION ($(wc -l < "$CHILD_SESSION") lines)"
say "child pg_say result: $(grep -o '"toolName":"pg_say".\{0,160\}' "$CHILD_SESSION" | tail -1)"
MSGS=$(api_get "/v1/messages?to=g:$ROOT_ID" "$HUMAN_TOKEN")
printf '%s\n' "$MSGS" > "$OUT/messages-group-root.json"
say "group messages: $(printf '%s' "$MSGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.items??[]).map(m=>`${m.sender_name}:${m.seq}:${String(m.body).slice(0,40)}`).join(" | "))})')"
# pg_spawn waits for the child to be idle, so a long tool in the *first* turn cannot be
# running when the root deletes anything. For the mid-tool variant the child is brought
# up normally, then the root tells it (through pg_say) to run one long bash command, and
# the delete follows while that tool is actually running.
BASH_CALL_RE='"type":"toolCall","id":"[^"]*","name":"bash"'
if [[ "$CHILD_TASK" == "midtool" ]]; then
  herdr agent wait "$CHILD_PANE" --until idle --timeout 180000 > "$OUT/wait-child.json" 2>&1
  say "child idle after its first turn: $(head -c 160 "$OUT/wait-child.json")"
  PROMPT_LONG="Call the pg_say tool exactly once with to=$CHILD_ID and text=\"Now call the bash tool exactly once with command 'sleep $CHILD_TOOL_SLEEP', then stop.\" Then stop."
  say "prompt(start the long tool): $PROMPT_LONG"
  herdr agent prompt "$ROOT_PANE" "$PROMPT_LONG" --wait --timeout 180000 > "$OUT/prompt-long.json" 2>&1
  say "long-tool instruction turn settled: $(head -c 160 "$OUT/prompt-long.json")"
  say "waiting for the child's real bash toolCall"
  SEEN=""
  for _ in $(seq 1 900); do
    if grep -Eq "$BASH_CALL_RE" "$CHILD_SESSION" 2>/dev/null; then SEEN=yes; break; fi
    sleep 0.2
  done
  [[ -n "$SEEN" ]] || die "the child never called the bash tool"
  say "bash toolCall in the child session: $(grep -o '"type":"toolCall","id":"[^"]*","name":"bash".\{0,90\}' "$CHILD_SESSION" | head -1)"
  sleep 1
else
  herdr agent wait "$CHILD_PANE" --until idle --timeout 180000 > "$OUT/wait-child.json" 2>&1
  say "child idle: $(head -c 200 "$OUT/wait-child.json")"
fi
herdr pane read "$CHILD_PANE" --source recent-unwrapped --lines 40 > "$OUT/child-pane-before-terminate.txt" 2>&1
say "child pane tail (before terminate): $(tail -3 "$OUT/child-pane-before-terminate.txt" | tr '\n' ' ' | cut -c1-200)"
herdr pane list > "$OUT/panes-child-running.json"
say "child running pane entry: $(node -e '
  const fs=require("node:fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const p=j.result.panes.find(x=>x.pane_id===process.argv[2]);
  console.log(JSON.stringify({pane_id:p?.pane_id,agent:p?.agent,agent_status:p?.agent_status,interactive_ready:p?.interactive_ready,title:p?.terminal_title_stripped}));
' "$OUT/panes-child-running.json" "$CHILD_PANE")"

say "child session at pre-terminate: $(stat -c '%s bytes, mtime %y' "$CHILD_SESSION")"

say "== 7. sample, then terminate =="
: > "$OUT/sampler-stop"
rm -f "$OUT/sampler-stop"
node "$OUT/pane-sampler.mjs" "$CHILD_PANE" "$OUT/pane-samples.tsv" "$OUT/child-pane-at-exit.txt" "$OUT/sampler-stop" &
SAMPLERS+=($!)
node "$OUT/pid-sampler.mjs" "$CPID" "$OUT/pid-samples.tsv" "$OUT/sampler-stop" &
SAMPLERS+=($!)
sleep 0.5

PROMPT_TERM="Call the pg_terminate tool exactly once with member=$CHILD_ID. Then stop. Do not send any message."
say "prompt(terminate): $PROMPT_TERM"
T_CLOSE_REQUEST=$(now_ms)
herdr agent prompt "$ROOT_PANE" "$PROMPT_TERM" --wait --timeout 180000 > "$OUT/prompt-terminate.json" 2>&1
T_TERM_DONE=$(now_ms)
say "terminate turn settled at $T_TERM_DONE: $(head -c 300 "$OUT/prompt-terminate.json")"

say "== 8. wait for the pane to disappear =="
PANE_GONE_AT=""
for _ in $(seq 1 300); do
  if ! herdr pane list | grep -q "\"$CHILD_PANE\""; then PANE_GONE_AT=$(now_ms); break; fi
  sleep 0.1
done
say "child pane absent from pane list at $PANE_GONE_AT ($(stamp))"
touch "$OUT/sampler-stop"
wait "${SAMPLERS[@]}" 2>/dev/null
SAMPLERS=()

say "== 9. post state =="
herdr pane list > "$OUT/panes-after-terminate.json"
herdr agent list > "$OUT/agents-after-terminate.json" 2>&1
api_get "/v1/members/$CHILD_ID" "$ROOT_TOKEN" > "$OUT/member-after-terminate.json"
api_get /v1/tree "$ROOT_TOKEN" > "$OUT/tree-after-terminate.json"
api_get "/v1/control?all&limit=200" "$HUMAN_TOKEN" > "$OUT/controls-after-terminate.json"
ps -eo pid,ppid,lstart,args > "$OUT/ps-after-terminate.txt"
say "member: $(head -c 200 "$OUT/member-after-terminate.json")"
say "remaining child pi processes: $(ps -eo pid,args | grep -F -- "--session-dir $CHILDSESS" | grep -v grep | wc -l)"
say "child pane in pane list: $(grep -c "\"$CHILD_PANE\"" "$OUT/panes-after-terminate.json")"

say "== 10. copy and validate the child's session file =="
cp "$CHILD_SESSION" "$OUT/child-session.jsonl"
node -e '
const fs = require("node:fs");
const t = fs.readFileSync(process.argv[1], "utf8");
const raw = t.split("\n");
const lines = raw.filter((l) => l.length > 0);
let bad = 0;
const objs = [];
for (const [i, l] of lines.entries()) { try { objs.push(JSON.parse(l)); } catch (e) { bad++; console.log(`BAD line ${i + 1}: ${e.message}`); } }
const last = objs[objs.length - 1] ?? {};
console.log(`lines=${lines.length} bad=${bad} endsWithNewline=${t.endsWith("\n")}`);
console.log(`last.type=${last.type} role=${last.message?.role ?? ""} stopReason=${last.message?.stopReason ?? ""}`);
console.log(`entry types: ${objs.map((o) => o.type).join(",")}`);
const say = objs.filter((o) => o.message?.role === "toolResult" && o.message?.toolName === "pg_say");
console.log(`pg_say tool results: ${say.length}`);
' "$OUT/child-session.jsonl" | tee "$OUT/child-session-check.txt"

say "== 10b. the root's own transcript (pg_terminate result) =="
ROOT_SESSION=$(find "$ROOTSESS" -name '*.jsonl' 2>/dev/null | head -1)
if [[ -n "$ROOT_SESSION" ]]; then
  cp "$ROOT_SESSION" "$OUT/root-session.jsonl"
  node -e '
    const fs = require("node:fs");
    const objs = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const results = objs.filter((o) => o.message?.role === "toolResult" && o.message?.toolName === "pg_terminate");
    const out = results.map((o) => `${o.timestamp} ${JSON.stringify(o.message.content)}`).join("\n");
    fs.writeFileSync(process.argv[2], out + "\n");
    console.log(out);
  ' "$OUT/root-session.jsonl" "$OUT/root-terminate-result.txt"
  say "root session $ROOT_SESSION ($(wc -l < "$ROOT_SESSION") lines)"
fi

say "== 11. herdr server log window (pane close) =="
LOG=$HOME/.config/herdr/herdr-server.log
FROM=$(date -u -d "@$(( (T_CLOSE_REQUEST - 10000) / 1000 ))" +%Y-%m-%dT%H:%M:%S)
awk -v from="$FROM" '$1 >= from' "$LOG" | grep -E 'pane.close|pane\.exit|pane session terminated|PANE_CLOSE' > "$OUT/herdr-server-window.txt"
cat "$OUT/herdr-server-window.txt"
say "harvest: $OUT/pid-samples.tsv $(wc -l < "$OUT/pid-samples.tsv") lines; pane-samples $(wc -l < "$OUT/pane-samples.tsv") lines"

{ echo "PORT=$PORT"; echo "MODEL=$MODEL"; echo "SPAWN_CMD=$SPAWN_CMD";
  echo "DATA=$DATA"; echo "ADIR=$ADIR"; echo "SCRATCH=$SCRATCH";
  echo "ROOTSESS=$ROOTSESS"; echo "CHILDSESS=$CHILDSESS";
  echo "PLATFORM_PID=$PLATFORM_PID"; echo "ROOT_ID=$ROOT_ID"; echo "ROOT_PANE=$ROOT_PANE";
  echo "CHILD_ID=$CHILD_ID"; echo "CHILD_PANE=$CHILD_PANE"; echo "CHILD_PID=$CPID";
  echo "CHILD_SESSION=$CHILD_SESSION"; } > "$OUT/env.sh"

say "== done; see timeline.txt for the verdict =="
