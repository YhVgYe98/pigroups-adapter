#!/usr/bin/env bash
# Real-machine probe for pg_org_start (adapter 0.6.0).
#
# One tab, two pi sessions, one platform:
#   1. an unconfigured pi (package installed through an isolated settings.json that
#      names the same package as ~/.pi/agent/settings.json) sees only pg_org_start,
#      calls it, and becomes root of a platform the tool starts;
#   2. the root spawns one child through pg_spawn; the child joins the same platform
#      and answers in the group;
#   3. the root process is killed; the platform keeps answering and the child's
#      last_seen_at keeps advancing;
#   4. a second unconfigured pi calls pg_org_start again and reattaches to the same
#      platform (same pid, same port, one platform process);
#   5. everything this script started is stopped and the pane set is compared to the
#      baseline taken before it began.
#
# Nothing outside this directory is written, except the throwaway /tmp dirs (removed
# at the end) and the herdr panes/tab (closed at the end).
set -uo pipefail

OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADAPTER=/home/yang/Documents/pigroups-adapter
PG=/home/yang/Documents/PiGroups
MODEL=deepseek/deepseek-flash
WORK="$(mktemp -d /tmp/pgorg-probe.XXXXXX)"
AGENT="$WORK/agent"
ADIR="$WORK/adapter"
SCRATCH="$WORK/scratch"
ROOTSESS="$WORK/root-sessions"
REATTACHSESS="$WORK/reattach-sessions"
CHILDSESS="$WORK/child-sessions"
mkdir -p "$AGENT" "$ADIR" "$SCRATCH" "$ROOTSESS" "$REATTACHSESS" "$CHILDSESS"
cat > "$AGENT/settings.json" <<'JSON'
{
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-flash",
  "packages": ["/home/yang/Documents/pigroups-adapter"]
}
JSON

stamp() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
say() { printf '[org-start] %s %s\n' "$(stamp)" "$*" | tee -a "$OUT/run.txt"; }
die() { say "FATAL: $*"; exit 2; }
now_ms() { date +%s%3N; }

TAB_ID=""
ROOT_PANE=""
REATTACH_PANE=""
CHILD_PANE=""
ROOT_PID=""
REATTACH_PID=""
CHILD_PID=""
PLATFORM_PID=""
FAILED=0
pass() { say "PASS  $*"; }
fail() { say "FAIL  $*"; FAILED=1; }
note() { say "NOTE  $*"; }

cleanup() {
  local status=$?
  set +e
  say "== cleanup =="
  for pane in "$CHILD_PANE" "$REATTACH_PANE" "$ROOT_PANE"; do
    if [[ -n "$pane" ]]; then
      herdr pane close "$pane" >/dev/null 2>&1
      say "closed pane $pane (exit $?)"
    fi
  done
  if [[ -n "$TAB_ID" ]]; then
    herdr tab close "$TAB_ID" >/dev/null 2>&1
    say "closed tab $TAB_ID (exit $?)"
  fi
  # Preserve the adapter state and pi transcripts before the temp tree goes away.
  mkdir -p "$OUT/sessions" "$OUT/adapter-state"
  cp "$ADIR"/org.json "$OUT/adapter-state/" 2>/dev/null
  cp "$ADIR"/platform-data/platform.log "$OUT/adapter-state/" 2>/dev/null
  cp "$ADIR"/org.lock "$OUT/adapter-state/" 2>/dev/null
  for dir in "$ROOTSESS" "$REATTACHSESS" "$CHILDSESS"; do
    find "$dir" -name '*.jsonl' -type f 2>/dev/null | while read -r f; do
      cp "$f" "$OUT/sessions/$(basename "$(dirname "$f")")_$(basename "$f")" 2>/dev/null
    done
  done
  if [[ -f "$ADIR/org.json" ]]; then
    PLATFORM_PID=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid)}catch{}' "$ADIR/org.json")
  fi
  if [[ -n "$PLATFORM_PID" ]] && kill -0 "$PLATFORM_PID" 2>/dev/null; then
    if grep -q 'src/main.ts' "/proc/$PLATFORM_PID/cmdline" 2>/dev/null; then
      kill -TERM "$PLATFORM_PID" 2>/dev/null
      for _ in $(seq 1 50); do kill -0 "$PLATFORM_PID" 2>/dev/null || break; sleep 0.1; done
      kill -KILL "$PLATFORM_PID" 2>/dev/null
      say "platform pid $PLATFORM_PID stopped"
    else
      say "refused to signal pid $PLATFORM_PID: cmdline is not the platform"
    fi
  fi
  herdr pane list > "$OUT/panes-final.json" 2>&1
  node "$OUT/platform-instances.mjs" "$ADIR/platform-data" > "$OUT/platform-after.txt" 2>&1
  say "final platform instances: $(tr '\n' ' ' < "$OUT/platform-after.txt")"
  node -e '
    const fs=require("node:fs");
    const before=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).result.panes.map(p=>p.pane_id).sort();
    const after=JSON.parse(fs.readFileSync(process.argv[2],"utf8")).result.panes.map(p=>p.pane_id).sort();
    const added=after.filter(p=>!before.includes(p));
    const gone=before.filter(p=>!after.includes(p));
    fs.writeFileSync(process.argv[3], `baseline: ${before.join(" ")}\nfinal:    ${after.join(" ")}\nadded:    ${added.join(" ")}\nmissing:  ${gone.join(" ")}\n`);
    console.log(`pane diff: added=[${added.join(" ")}] missing=[${gone.join(" ")}]`);
  ' "$OUT/panes-baseline.json" "$OUT/panes-final.json" "$OUT/pane-diff.txt" | tee -a "$OUT/run.txt"
  if [[ "$status" -eq 0 && "$FAILED" -ne 0 ]]; then status=1; fi
  say "temp work dir $WORK kept for inspection? $([[ "${KEEP_TMP:-0}" == 1 ]] && echo yes || echo no)"
  [[ "${KEEP_TMP:-0}" == 1 ]] || rm -rf "$WORK"
  say "driver exit $status"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

pick() { # dotted.path, JSON on stdin; falls back to the first matching key anywhere
  node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      let j; try { j=JSON.parse(s); } catch { return console.log(""); }
      const path=process.argv[1].split(".");
      let direct=j;
      for (const part of path) { if (direct==null) break; direct=direct[part]; }
      if (direct!==undefined) { console.log(direct===null?"":typeof direct==="object"?JSON.stringify(direct):String(direct)); return; }
      const key=path[path.length-1];
      const walk=(v)=>{ if (v&&typeof v==="object") { if (key in v) return v[key]; for (const k of Object.keys(v)) { const r=walk(v[k]); if (r!==undefined) return r; } } };
      const found=walk(j);
      console.log(found===undefined||found===null?"":typeof found==="object"?JSON.stringify(found):String(found));
    });' "$1"
}

wait_for() { # timeout-seconds label command...
  local timeout="$1" label="$2"; shift 2
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  return 1
}

session_file() { find "$1" -name '*.jsonl' -type f 2>/dev/null | head -1; }

observed_pg_tools() { # events-file event [tool]
  node -e '
    const fs=require("node:fs");
    const file=process.argv[1];
    const event=process.argv[2]; const tool=process.argv[3]||"";
    let lines=[];
    try { lines=fs.readFileSync(file,"utf8").trim().split("\n").filter(Boolean); } catch { process.exit(0); }
    let found=null;
    for (const line of lines) {
      let j; try { j=JSON.parse(line); } catch { continue; }
      if (j.event!==event) continue;
      if (tool!=="" && j.tool!==tool) continue;
      found=j;
    }
    if (found) console.log((found.active??[]).filter(n=>String(n).startsWith("pg_")).sort().join(","));
  ' "$1" "$2" "${3:-}"
}

wait_observed() { # events-file event [tool] timeout
  local file="$1" event="$2" tool="${3:-}" timeout="${4:-120}"
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    [[ -s "$file" ]] && grep -q "\"event\":\"$event\"" "$file" && {
      if [[ -z "$tool" ]] || grep -q "\"tool\":\"$tool\"" "$file"; then return 0; fi
    }
    sleep 0.25
  done
  return 1
}

has_tool_result() { # session-file tool-name
  node -e '
    const fs=require("node:fs");
    let lines=[];
    try { lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean); } catch { process.exit(1); }
    for (const line of lines) {
      let j; try { j=JSON.parse(line); } catch { continue; }
      const m=j.message;
      if (m?.role==="toolResult" && m.toolName===process.argv[2] && m.isError!==true) process.exit(0);
    }
    process.exit(1);
  ' "$1" "$2"
}

last_assistant_text() { # session-file
  node -e '
    const fs=require("node:fs");
    const lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n");
    let out="";
    for (const line of lines) {
      let j; try { j=JSON.parse(line); } catch { continue; }
      if (j.message?.role!=="assistant") continue;
      const c=j.message.content;
      if (!Array.isArray(c)) continue;
      const text=c.filter(x=>x.type==="text").map(x=>x.text).join("\n");
      if (text.trim()!=="") out=text;
    }
    console.log(out);
  ' "$1"
}

tool_calls() { # session-file
  node -e '
    const fs=require("node:fs");
    const lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n");
    for (const line of lines) {
      let j; try { j=JSON.parse(line); } catch { continue; }
      const c=j.message?.content;
      if (!Array.isArray(c)) continue;
      for (const x of c) if (x.type==="toolCall") console.log(JSON.stringify(x));
    }
  ' "$1"
}

pane_pid() { # pane
  herdr pane process-info --pane "$1" 2>/dev/null | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      try {
        const j=JSON.parse(s);
        const ps=j.result?.process_info?.foreground_processes ?? [];
        if (ps.length) console.log(ps[0].pid);
      } catch {}
    });'
}

health() { curl -sf -m 2 "$1/v1/health" >/dev/null 2>&1; }

api_get() { curl -s -m 5 "$1$2" -H "Authorization: Bearer $3"; }

# ---------------------------------------------------------------- 0. baseline

say "== 0. baseline =="
{ echo "commit: $(git -C "$ADAPTER" rev-parse HEAD)";
  echo "version: $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$ADAPTER/package.json")";
  echo "pi: $(pi --version 2>&1)";
  echo "herdr: $(herdr --version 2>&1 | head -1)";
  echo "platform: $(git -C "$PG" rev-parse HEAD)";
  echo "setting package entry: $(node -e 'const s=require(process.argv[1]);console.log((s.packages??[]).filter(x=>String(x).includes("pigroups-adapter")).join(","))' /home/yang/.pi/agent/settings.json)";
} > "$OUT/tree.txt"
git -C "$ADAPTER" status --porcelain >> "$OUT/tree.txt"
herdr pane list > "$OUT/panes-baseline.json"
node "$OUT/platform-instances.mjs" "$ADIR/platform-data" > "$OUT/platform-baseline.txt" 2>&1
say "baseline panes: $(grep -o '"pane_id":"[^"]*"' "$OUT/panes-baseline.json" | cut -d'"' -f4 | tr '\n' ' ')"
say "commit $(git -C "$ADAPTER" rev-parse --short HEAD), platform $(git -C "$PG" rev-parse --short HEAD)"
say "temp work dir $WORK"
say "isolated settings: $AGENT/settings.json names the same package as ~/.pi/agent/settings.json"

WORKSPACE="${HERDR_WORKSPACE_ID:-}"
if [[ -z "$WORKSPACE" ]]; then
  WORKSPACE="$(herdr pane current --current 2>/dev/null | grep -o '"workspace_id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
fi
[[ -n "$WORKSPACE" ]] || die "cannot determine herdr workspace"

ENV_ARGS=(
  --env "PI_CODING_AGENT_DIR=$AGENT"
  --env "PIGROUPS_ADAPTER_DIR=$ADIR"
  --env "PIGROUPS_SPAWN_CMD=pi -ne -e $ADAPTER/src/extension.ts --model $MODEL --session-dir $CHILDSESS --name probe-child"
  --env "PROBE_TOOLS_FILE=$OUT/tools-events.jsonl"
)
for key in DEEPSEEK_API_KEY OPENROUTER_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY ZAI_CODING_CN_API_KEY GLM_API_KEY GEMINI_API_KEY; do
  if [[ -n "${!key:-}" ]]; then ENV_ARGS+=(--env "$key=${!key}"); fi
done
# The root must not inherit an identity. The driver shell has neither variable, and
# these unset markers make the assertion explicit in the record.
unset PIGROUPS_URL PIGROUPS_TOKEN

say "== 1. unconfigured root pane =="
CREATE=$(herdr tab create --workspace "$WORKSPACE" --cwd "$SCRATCH" --label "org-start-probe" "${ENV_ARGS[@]}" --no-focus)
printf '%s\n' "$CREATE" > "$OUT/tab-create.json"
TAB_ID=$(printf '%s' "$CREATE" | pick tab_id)
ROOT_PANE=$(printf '%s' "$CREATE" | pick pane_id)
[[ -n "$TAB_ID" && -n "$ROOT_PANE" ]] || die "tab create returned no ids: $CREATE"
say "tab $TAB_ID, root pane $ROOT_PANE (not focused)"

for _ in $(seq 1 80); do
  herdr pane process-info --pane "$ROOT_PANE" 2>/dev/null | grep -Eq '"name":"(bash|zsh|sh|fish|dash)"' && break
  sleep 0.25
done

herdr agent start probe-root --kind pi --pane "$ROOT_PANE" --timeout 180000 \
  -- --model "$MODEL" -e "$OUT/observe.ts" --session-dir "$ROOTSESS" --name probe-root \
  > "$OUT/agent-start-root.json" 2>&1
say "root agent start: $(head -c 240 "$OUT/agent-start-root.json")"
herdr agent wait "$ROOT_PANE" --until idle --timeout 180000 > "$OUT/wait-root.json" 2>&1
say "root idle: $(head -c 160 "$OUT/wait-root.json")"

wait_observed "$OUT/tools-events.jsonl" session_start "" 30 || die "observer saw no session_start"
BEFORE_TOOLS=$(observed_pg_tools "$OUT/tools-events.jsonl" session_start)
printf '%s\n' "$BEFORE_TOOLS" > "$OUT/tools-before.txt"
say "pg tools visible before the call: '$BEFORE_TOOLS'"
[[ "$BEFORE_TOOLS" == "pg_org_start" ]] && pass "1.0 unconfigured session has only pg_org_start" \
  || fail "1.0 expected only pg_org_start, saw '$BEFORE_TOOLS'"

BEFORE_ENV=$(tr '\0' '\n' < "/proc/$(pane_pid "$ROOT_PANE")/environ" 2>/dev/null | grep -E '^PIGROUPS_(URL|TOKEN)=' || true)
if [[ -z "$BEFORE_ENV" ]]; then pass "1.0b root pane has no PIGROUPS_URL/PIGROUPS_TOKEN"; else fail "1.0b root pane inherited identity: $BEFORE_ENV"; fi

herdr pane read "$ROOT_PANE" --source recent-unwrapped --lines 60 > "$OUT/root-pane-before-call.txt" 2>&1

say "== 1a. call pg_org_start =="
PROMPT_CALL="Call the pg_org_start tool exactly once with name=\"probe-root\". Do not pass platform_dir or any other argument. Do not call any other tool. Then report its JSON result verbatim and stop."
say "prompt: $PROMPT_CALL"
herdr agent prompt "$ROOT_PANE" "$PROMPT_CALL" --wait --timeout 300000 > "$OUT/prompt-org-start.json" 2>&1
say "org-start turn settled: $(head -c 240 "$OUT/prompt-org-start.json")"

for _ in $(seq 1 240); do [[ -f "$ADIR/org.json" ]] && break; sleep 0.25; done
ROOT_SESSION=$(session_file "$ROOTSESS")
[[ -f "$ADIR/org.json" ]] || die "org.json was not written; root answer: $([[ -n "$ROOT_SESSION" ]] && last_assistant_text "$ROOT_SESSION" || echo unavailable)"
[[ -n "$ROOT_SESSION" ]] || die "root session file not found after the call"
cp "$ROOT_SESSION" "$OUT/sessions/root-initial.jsonl"
tool_calls "$ROOT_SESSION" > "$OUT/root-tool-calls.txt"
wait_observed "$OUT/tools-events.jsonl" tool_execution_end pg_org_start 30 || true
cp "$ADIR/org.json" "$OUT/org.json"
URL=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).url)' "$ADIR/org.json")
TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token)' "$ADIR/org.json")
ADMIN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).admin_token)' "$ADIR/org.json")
PLATFORM_PID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid)' "$ADIR/org.json")
DATA_DIR=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).data_dir)' "$ADIR/org.json")
ROOT_ID=$(api_get "$URL" /v1/whoami "$TOKEN" | pick member.id)
say "org.json: url=$URL pid=$PLATFORM_PID data_dir=$DATA_DIR root=$ROOT_ID"
health "$URL" && pass "1.1 platform answers /v1/health" || fail "1.1 platform does not answer"
[[ -f "$DATA_DIR/platform.log" ]] && pass "1.2 detached platform writes $DATA_DIR/platform.log" || fail "1.2 no platform.log"
stat -c '%a %n' "$ADIR/org.json" > "$OUT/org-json-mode.txt" 2>&1
[[ "$(stat -c '%a' "$ADIR/org.json")" == "600" ]] && pass "1.2b org.json is 0600" || fail "1.2b org.json mode $(stat -c '%a' "$ADIR/org.json")"

api_get "$URL" /v1/whoami "$TOKEN" > "$OUT/whoami-root.json"
api_get "$URL" /v1/tree "$TOKEN" > "$OUT/tree-root.json"
cp "$ROOT_SESSION" "$OUT/sessions/root-after-org-start.jsonl"
last_assistant_text "$ROOT_SESSION" > "$OUT/root-answer-org-start.txt"
if grep -q '"reattached": false' "$OUT/root-answer-org-start.txt" && grep -q "$URL" "$OUT/root-answer-org-start.txt"; then
  pass "1.3 tool answer names the URL and reattached=false"
else
  fail "1.3 tool answer does not contain the expected JSON: $(head -c 300 "$OUT/root-answer-org-start.txt")"
fi
[[ "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).member.is_root)' "$OUT/whoami-root.json")" == "true" ]] \
  && pass "1.4 session is the root" || fail "1.4 whoami is not root"
herdr pane read "$ROOT_PANE" --source recent-unwrapped --lines 80 > "$OUT/root-pane-after-call.txt" 2>&1

say "== 1b. tools after success =="
AFTER_TOOLS=$(observed_pg_tools "$OUT/tools-events.jsonl" tool_execution_end pg_org_start)
printf '%s\n' "$AFTER_TOOLS" > "$OUT/tools-after.txt"
say "pi's active pg tools after the call: '$AFTER_TOOLS'"
for tool in pg_say pg_members pg_spawn pg_terminate pg_children pg_inspect pg_whoami pg_abort pg_schedule pg_read; do
  printf '%s\n' "$AFTER_TOOLS" | tr ',' '\n' | grep -qx "$tool" || fail "1.5 $tool is not active after success"
done
herdr agent prompt "$ROOT_PANE" "Without calling any tool, list the names of every tool you can currently see whose name starts with pg_. Answer with just the comma-separated names." --wait --timeout 120000 > "$OUT/prompt-tools-after.json" 2>&1
cp "$ROOT_SESSION" "$OUT/sessions/root-after-tools.jsonl"
last_assistant_text "$ROOT_SESSION" > "$OUT/tools-after-model.txt"
say "model says pg tools now: $(tr '\n' ' ' < "$OUT/tools-after-model.txt")"

say "== 2. root spawns one child =="
HERDR_PANE_BEFORE_SPAWN="$OUT/panes-before-spawn.json"
herdr pane list > "$HERDR_PANE_BEFORE_SPAWN"
BRIEF="You are probe-child, a member of this PiGroups organisation. Call pg_say exactly once with to=\"g:$ROOT_ID\" and text=\"probe-child joined the same platform and answered\". Then stop."
PROMPT_SPAWN="Call pg_spawn exactly once with name=\"probe-child\" and this brief: \"$BRIEF\" Do not call any other tool before pg_spawn. After it returns, report the member id and stop."
say "prompt: $PROMPT_SPAWN"
herdr agent prompt "$ROOT_PANE" "$PROMPT_SPAWN" --wait --timeout 300000 > "$OUT/prompt-spawn.json" 2>&1
say "spawn turn settled: $(head -c 240 "$OUT/prompt-spawn.json")"

CHILD_ID=""
for _ in $(seq 1 200); do
  TREE=$(api_get "$URL" /v1/tree "$TOKEN")
  CHILD_ID=$(printf '%s' "$TREE" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const n=(j.nodes??[]).find(x=>x.parent_id!==null);console.log(n?n.id:"")}catch{}})')
  [[ -n "$CHILD_ID" ]] && break
  sleep 0.25
done
[[ -n "$CHILD_ID" ]] || die "platform tree never showed the child"
printf '%s\n' "$TREE" > "$OUT/tree-after-spawn.json"
say "child member $CHILD_ID"
pass "2.1 pg_spawn created a child under the root"

herdr pane list > "$OUT/panes-after-spawn.json"
CHILD_PANE=$(node -e '
  const fs=require("node:fs");
  const before=new Set(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).result.panes.map(p=>p.pane_id));
  const now=JSON.parse(fs.readFileSync(process.argv[2],"utf8")).result.panes.map(p=>p.pane_id);
  console.log(now.filter(p=>!before.has(p)&&p!==process.argv[3]).join(" "));
' "$HERDR_PANE_BEFORE_SPAWN" "$OUT/panes-after-spawn.json" "$ROOT_PANE" | awk '{print $1}')
[[ -n "$CHILD_PANE" ]] || die "cannot identify the child pane"
CHILD_PID=$(pane_pid "$CHILD_PANE")
say "child pane $CHILD_PANE, pid ${CHILD_PID:-unknown}"
herdr pane process-info --pane "$CHILD_PANE" > "$OUT/child-process-info.json" 2>&1
herdr pane read "$CHILD_PANE" --source recent-unwrapped --lines 50 > "$OUT/child-pane.txt" 2>&1

CHILD_SESSION=""
CHILD_SAID=""
for _ in $(seq 1 480); do
  CHILD_SESSION=$(session_file "$CHILDSESS")
  if [[ -n "$CHILD_SESSION" ]] && has_tool_result "$CHILD_SESSION" pg_say; then CHILD_SAID=yes; break; fi
  sleep 0.25
done
[[ -n "$CHILD_SESSION" ]] || die "no child session under $CHILDSESS"
cp "$CHILD_SESSION" "$OUT/sessions/child.jsonl"
[[ "$CHILD_SAID" == "yes" ]] && pass "2.2 child called pg_say and got a successful result" || fail "2.2 child never completed a pg_say call"
tool_calls "$CHILD_SESSION" > "$OUT/child-tool-calls.txt" 2>&1
last_assistant_text "$CHILD_SESSION" > "$OUT/child-answer.txt"

HUMAN=$(curl -sX POST "$URL/v1/humans" -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"name":"org-start-probe-human"}')
printf '%s\n' "$HUMAN" > "$OUT/human.json"
HUMAN_TOKEN=$(printf '%s' "$HUMAN" | pick token)
[[ -n "$HUMAN_TOKEN" ]] || die "could not create a human token: $HUMAN"
for _ in $(seq 1 240); do
  api_get "$URL" "/v1/messages?to=g:$ROOT_ID" "$HUMAN_TOKEN" > "$OUT/messages-group.json"
  grep -q 'probe-child joined the same platform and answered' "$OUT/messages-group.json" && break
  sleep 0.5
done
if grep -q 'probe-child joined the same platform and answered' "$OUT/messages-group.json"; then
  pass "2.3 the child's answer is visible in the group"
else
  fail "2.3 group has no child answer: $(head -c 300 "$OUT/messages-group.json")"
fi

say "== 3. the organisation outlives the root session =="
CHILD_BEFORE=$(api_get "$URL" "/v1/members/$CHILD_ID" "$TOKEN")
printf '%s\n' "$CHILD_BEFORE" > "$OUT/child-before-root-kill.json"
LAST_BEFORE=$(printf '%s' "$CHILD_BEFORE" | pick member.last_seen_at)
ROOT_PID=$(pane_pid "$ROOT_PANE")
[[ -n "$ROOT_PID" ]] || die "cannot identify the root pi process"
say "root pi pid $ROOT_PID; child last_seen_at before kill $LAST_BEFORE"
kill -TERM "$ROOT_PID"
for _ in $(seq 1 100); do kill -0 "$ROOT_PID" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$ROOT_PID" 2>/dev/null; then fail "3.1 root pi did not exit"; else pass "3.1 root pi process is gone"; fi
sleep 3
health "$URL" && pass "3.2 platform still answers after the root session died" || fail "3.2 platform is gone with the root"

LAST_AFTER="$LAST_BEFORE"
for _ in $(seq 1 80); do
  NOW=$(api_get "$URL" "/v1/members/$CHILD_ID" "$TOKEN")
  LAST_AFTER=$(printf '%s' "$NOW" | pick member.last_seen_at)
  [[ -n "$LAST_AFTER" && "$LAST_AFTER" != "$LAST_BEFORE" ]] && break
  sleep 0.5
done
printf '%s\n' "$NOW" > "$OUT/child-after-root-kill.json"
if [[ -n "$LAST_AFTER" && "$LAST_AFTER" != "$LAST_BEFORE" ]]; then
  pass "3.3 child's last_seen_at advanced after the root died: $LAST_BEFORE -> $LAST_AFTER"
else
  fail "3.3 child's last_seen_at did not advance (still $LAST_BEFORE)"
fi
api_get "$URL" /v1/tree "$TOKEN" > "$OUT/tree-after-root-kill.json"

say "== 4. a later unconfigured session reattaches =="
SPLIT=$(herdr pane split --direction down --no-focus --pane "$ROOT_PANE" --cwd "$SCRATCH" "${ENV_ARGS[@]}" --env "PROBE_TOOLS_FILE=$OUT/tools-events-reattach.jsonl")
printf '%s\n' "$SPLIT" > "$OUT/pane-split-reattach.json"
REATTACH_PANE=$(printf '%s' "$SPLIT" | pick pane_id)
[[ -n "$REATTACH_PANE" ]] || die "reattach pane split returned no pane id: $SPLIT"
for _ in $(seq 1 80); do
  herdr pane process-info --pane "$REATTACH_PANE" 2>/dev/null | grep -Eq '"name":"(bash|zsh|sh|fish|dash)"' && break
  sleep 0.25
done
herdr agent start probe-reattach --kind pi --pane "$REATTACH_PANE" --timeout 180000 \
  -- --model "$MODEL" -e "$OUT/observe.ts" --session-dir "$REATTACHSESS" --name probe-reattach \
  > "$OUT/agent-start-reattach.json" 2>&1
herdr agent wait "$REATTACH_PANE" --until idle --timeout 180000 > "$OUT/wait-reattach.json" 2>&1
wait_observed "$OUT/tools-events-reattach.jsonl" session_start "" 30 || die "reattach observer saw no session_start"
RE_BEFORE_TOOLS=$(observed_pg_tools "$OUT/tools-events-reattach.jsonl" session_start)
printf '%s\n' "$RE_BEFORE_TOOLS" > "$OUT/reattach-tools-before.txt"
say "reattach session pg tools before call: '$RE_BEFORE_TOOLS'"
[[ "$RE_BEFORE_TOOLS" == "pg_org_start" ]] && pass "4.1 later session starts with only pg_org_start" || fail "4.1 later session tools '$RE_BEFORE_TOOLS'"

URL_BEFORE="$URL"
PID_BEFORE="$PLATFORM_PID"
node "$OUT/platform-instances.mjs" "$DATA_DIR" > "$OUT/platform-before-reattach.txt" 2>&1
say "platform instances before reattach: $(tr '\n' ' ' < "$OUT/platform-before-reattach.txt")"

PROMPT_REATTACH="Call the pg_org_start tool exactly once with no arguments. Do not call any other tool. Then report its JSON result verbatim and stop."
herdr agent prompt "$REATTACH_PANE" "$PROMPT_REATTACH" --wait --timeout 300000 > "$OUT/prompt-reattach.json" 2>&1
say "reattach turn settled: $(head -c 240 "$OUT/prompt-reattach.json")"
REATTACH_SESSION=$(session_file "$REATTACHSESS")
[[ -n "$REATTACH_SESSION" ]] || die "reattach session file not found after the call"
cp "$REATTACH_SESSION" "$OUT/sessions/reattach-after-call.jsonl"
tool_calls "$REATTACH_SESSION" > "$OUT/reattach-tool-calls.txt"
last_assistant_text "$REATTACH_SESSION" > "$OUT/reattach-answer.txt"
cp "$ADIR/org.json" "$OUT/org-after-reattach.json"
URL_AFTER=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).url)' "$ADIR/org.json")
PID_AFTER=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid)' "$ADIR/org.json")
node "$OUT/platform-instances.mjs" "$DATA_DIR" > "$OUT/platform-after-reattach.txt" 2>&1
INSTANCES=$(grep -c . "$OUT/platform-after-reattach.txt" || true)
say "platform instances after reattach: $(tr '\n' ' ' < "$OUT/platform-after-reattach.txt")"
if grep -q '"reattached": true' "$OUT/reattach-answer.txt"; then pass "4.2 tool says reattached=true"; else fail "4.2 tool answer is not a reattach: $(head -c 300 "$OUT/reattach-answer.txt")"; fi
[[ "$URL_AFTER" == "$URL_BEFORE" ]] && pass "4.3 URL unchanged ($URL_AFTER)" || fail "4.3 URL moved $URL_BEFORE -> $URL_AFTER"
[[ "$PID_AFTER" == "$PID_BEFORE" ]] && pass "4.4 platform pid unchanged ($PID_AFTER)" || fail "4.4 platform pid changed $PID_BEFORE -> $PID_AFTER"
[[ "$INSTANCES" == "1" ]] && pass "4.5 exactly one platform process for the data dir" || fail "4.5 $INSTANCES platform processes"
REATTACH_PID=$(pane_pid "$REATTACH_PANE")
say "reattach pi pid ${REATTACH_PID:-unknown}"
herdr pane read "$REATTACH_PANE" --source recent-unwrapped --lines 80 > "$OUT/reattach-pane.txt" 2>&1

say "== 5. cleanup starts (trap) =="
say "SUMMARY failed=$FAILED"
exit 0
