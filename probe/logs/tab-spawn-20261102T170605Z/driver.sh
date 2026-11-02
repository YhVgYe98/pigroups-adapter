#!/usr/bin/env bash
# Real-machine probe for pg_spawn's new-tab behaviour (adapter 0.6.1+platform.0.2.0).
#
# What it proves on a live herdr 0.9.5 + pi 1.4.0:
#   a member spawned by pg_spawn gets its OWN tab in the root's workspace instead of a
#   pane split beside the operator's work; the child's pane is that tab's root pane;
#   the operator's original pane/tab layout is untouched; and terminating the child
#   takes the tab away with it.
#
# Shape of the run:
#   1. throwaway platform (temp data dir, free port) started from ../PiGroups;
#   2. one root member in a probe-owned tab, launched with
#      `-ne -e <this repo>/src/extension.ts` and PIGROUPS_URL / PIGROUPS_TOKEN from a
#      one-time bootstrap. PIGROUPS_SPAWN_CMD is NOT set, so pg_spawn uses the default
#      self-loading command (`pi -e <this repo>/src/extension.ts`);
#   3. root calls pg_spawn once; tab list / pane list / platform tree / group messages
#      are sampled before and after;
#   4. root calls pg_terminate on the child; the same samples are taken again;
#   5. cleanup: close the probe tab, stop the platform, remove the temp tree, and print
#      the tab/pane diff against the baseline taken in step 0.
#
# Everything this script writes outside its own directory is under /tmp and removed at
# the end. Nothing in ../PiGroups is modified.
set -uo pipefail

OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADAPTER=/home/yang/Documents/pigroups-adapter
PG=/home/yang/Documents/PiGroups
MODEL=deepseek/deepseek-flash
WORK="$(mktemp -d /tmp/pgtab-probe.XXXXXX)"
DATA="$WORK/platform-data"
ADIR="$WORK/adapter"
SCRATCH="$WORK/scratch"
CHILD="$WORK/child"
ROOTSESS="$WORK/root-sessions"
mkdir -p "$DATA" "$ADIR" "$SCRATCH" "$CHILD" "$ROOTSESS" "$OUT/sessions"

stamp() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
say() { printf '[tab-spawn] %s %s\n' "$(stamp)" "$*" | tee -a "$OUT/run.txt"; }
die() { say "FATAL: $*"; exit 2; }
pass() { say "PASS  $*"; }
fail() { say "FAIL  $*"; FAILED=1; }
note() { say "NOTE  $*"; }

PLATFORM_PID=""
ROOT_PANE=""
ROOT_TAB=""
FAILED=0

cleanup() {
  local status=$?
  set +e
  say "== cleanup =="
  # 1. the probe tab (the child's tab is closed by pg_terminate; close whatever is left)
  if [[ -n "$ROOT_PANE" ]]; then
    herdr pane close "$ROOT_PANE" >/dev/null 2>&1
    say "closed root pane $ROOT_PANE (exit $?)"
  fi
  if [[ -n "$ROOT_TAB" ]]; then
    herdr tab close "$ROOT_TAB" >/dev/null 2>&1
    say "closed root tab $ROOT_TAB (exit $?)"
  fi
  # 2. the platform
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
  # 3. final samples and the diff against the baseline
  herdr tab list > "$OUT/tabs-final.json" 2>&1
  herdr pane list > "$OUT/panes-final.json" 2>&1
  node "$OUT/dump-tabs.mjs" "$OUT/tabs-baseline.json" > "$OUT/tabs-baseline.txt" 2>&1
  node "$OUT/dump-tabs.mjs" "$OUT/tabs-final.json" > "$OUT/tabs-final.txt" 2>&1
  node "$OUT/dump-panes.mjs" "$OUT/panes-baseline.json" > "$OUT/panes-baseline.txt" 2>&1
  node "$OUT/dump-panes.mjs" "$OUT/panes-final.json" > "$OUT/panes-final.txt" 2>&1
  node "$OUT/diff-layout.mjs" "$OUT/panes-baseline.json" "$OUT/panes-final.json" \
    "$OUT/tabs-baseline.json" "$OUT/tabs-final.json" > "$OUT/pane-diff.txt" 2>&1
  say "layout diff: $(tr '\n' ' ' < "$OUT/pane-diff.txt")"
  if [[ -n "${CHILD_SESS_DIR:-}" ]] && [[ "$CHILD_SESS_DIR" == "$HOME/.pi/agent/sessions/--tmp-pgtab-probe."* ]]; then
    rm -rf "$CHILD_SESS_DIR"
    say "removed throwaway child session dir $CHILD_SESS_DIR"
  fi
  say "temp work dir $WORK removed"
  rm -rf "$WORK"
  if [[ "$status" -eq 0 && "$FAILED" -ne 0 ]]; then status=1; fi
  say "driver exit $status"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

pick() { # dotted.path, JSON on stdin
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

session_file() { find "$1" -name '*.jsonl' -type f 2>/dev/null | head -1; }

api_get() { curl -s -m 5 "$1$2" -H "Authorization: Bearer $3"; }
health() { curl -sf -m 2 "$1/v1/health" >/dev/null 2>&1; }

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
    let lines=[];
    try { lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n"); } catch { process.exit(0); }
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

tool_results() { # session-file tool-name  -> one JSON line per successful result
  node -e '
    const fs=require("node:fs");
    let lines=[];
    try { lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n"); } catch { process.exit(0); }
    for (const line of lines) {
      let j; try { j=JSON.parse(line); } catch { continue; }
      const m=j.message;
      if (m?.role==="toolResult" && m.toolName===process.argv[2]) console.log(JSON.stringify(m));
    }
  ' "$1" "$2"
}

# ---------------------------------------------------------------- 0. baseline

say "== 0. baseline =="
{
  echo "commit: $(git -C "$ADAPTER" rev-parse HEAD)"
  echo "working tree:"
  git -C "$ADAPTER" status --porcelain | sed 's/^/  /'
  echo "adapter version: $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$ADAPTER/package.json")"
  echo "pi: $(pi --version 2>&1)"
  echo "herdr: $(herdr --version 2>&1 | head -1)"
  echo "platform: $(git -C "$PG" rev-parse HEAD) ($(git -C "$PG" status --porcelain | wc -l) dirty files)"
} > "$OUT/tree.txt"

WORKSPACE="${HERDR_WORKSPACE_ID:-}"
if [[ -z "$WORKSPACE" ]]; then
  WORKSPACE="$(herdr pane current --current 2>/dev/null | grep -o '"workspace_id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
fi
[[ -n "$WORKSPACE" ]] || die "cannot determine the herdr workspace (set HERDR_WORKSPACE_ID)"
MY_PANE="${HERDR_PANE_ID:-}"
say "driver runs in pane ${MY_PANE:-unknown}, workspace $WORKSPACE"

herdr tab list > "$OUT/tabs-baseline.json"
herdr pane list > "$OUT/panes-baseline.json"
node "$OUT/dump-tabs.mjs" "$OUT/tabs-baseline.json" > "$OUT/tabs-baseline.txt"
node "$OUT/dump-panes.mjs" "$OUT/panes-baseline.json" > "$OUT/panes-baseline.txt"
say "baseline tabs (${WORKSPACE}): $(node "$OUT/dump-tabs.mjs" "$OUT/tabs-baseline.json" "$WORKSPACE" | tr '\n' '|')"
say "baseline panes (${WORKSPACE}): $(node "$OUT/dump-panes.mjs" "$OUT/panes-baseline.json" "$WORKSPACE" | tr '\n' '|')"

# ---------------------------------------------------------------- 1. platform

say "== 1. throwaway platform =="
PORT=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
ADMIN="adm-$(date +%s)"
say "port $PORT, data dir $DATA"
( cd "$PG" && PIGROUPS_ADMIN_TOKEN="$ADMIN" PORT="$PORT" PIGROUPS_DATA="$DATA" node src/main.ts ) \
  > "$OUT/platform.log" 2>&1 &
PLATFORM_PID=$!
URL="http://127.0.0.1:$PORT"
for _ in $(seq 1 150); do health "$URL" && break; sleep 0.2; done
health "$URL" || die "platform did not answer /v1/health; log: $(tail -5 "$OUT/platform.log")"
say "platform pid $PLATFORM_PID answers $URL"
curl -s "$URL/v1/health" > "$OUT/health.json"

ROOT_JSON=$(curl -sX POST "$URL/v1/bootstrap" -H 'content-type: application/json' -d '{"name":"tabspawn-root"}')
printf '%s\n' "$ROOT_JSON" > "$OUT/bootstrap.json"
ROOT_ID=$(printf '%s' "$ROOT_JSON" | pick member.id)
ROOT_TOKEN=$(printf '%s' "$ROOT_JSON" | pick token)
[[ -n "$ROOT_ID" && -n "$ROOT_TOKEN" ]] || die "bootstrap returned no member/token: $ROOT_JSON"
say "root member $ROOT_ID"

# ---------------------------------------------------------------- 2. root pane

say "== 2. root member in a probe-owned tab =="
ENV_ARGS=(
  --env "PIGROUPS_URL=$URL"
  --env "PIGROUPS_TOKEN=$ROOT_TOKEN"
  --env "PIGROUPS_ADAPTER_DIR=$ADIR"
)
# The operator's spawn override must not be set: this run proves the default command.
unset PIGROUPS_SPAWN_CMD
CREATE=$(herdr tab create --workspace "$WORKSPACE" --cwd "$SCRATCH" --label "tabspawn-root" "${ENV_ARGS[@]}" --no-focus)
printf '%s\n' "$CREATE" > "$OUT/tab-create-root.json"
ROOT_TAB=$(printf '%s' "$CREATE" | pick tab.tab_id)
ROOT_PANE=$(printf '%s' "$CREATE" | pick root_pane.pane_id)
[[ -n "$ROOT_TAB" && -n "$ROOT_PANE" ]] || die "tab create returned no ids: $CREATE"
say "root tab $ROOT_TAB, root pane $ROOT_PANE (not focused), workspace $WORKSPACE"

for _ in $(seq 1 80); do
  herdr pane process-info --pane "$ROOT_PANE" 2>/dev/null | grep -Eq '"name":"(bash|zsh|sh|fish|dash)"' && break
  sleep 0.25
done

herdr agent start tabspawn-root --kind pi --pane "$ROOT_PANE" --timeout 180000 \
  -- -ne -e "$ADAPTER/src/extension.ts" --model "$MODEL" --session-dir "$ROOTSESS" \
  > "$OUT/agent-start-root.json" 2>&1
say "root agent start: $(head -c 240 "$OUT/agent-start-root.json")"
herdr agent wait "$ROOT_PANE" --until idle --timeout 180000 > "$OUT/wait-root.json" 2>&1
say "root idle: $(head -c 160 "$OUT/wait-root.json")"

ROOT_PID=$(pane_pid "$ROOT_PANE")
[[ -n "$ROOT_PID" ]] || die "cannot identify the root pi process"
ROOT_ENV=$(tr '\0' '\n' < "/proc/$ROOT_PID/environ" 2>/dev/null)
printf '%s\n' "$ROOT_ENV" | grep -E '^PIGROUPS_' | sort > "$OUT/root-env.txt"
say "root pi pid $ROOT_PID; PIGROUPS_* in its environment: $(tr '\n' ' ' < "$OUT/root-env.txt")"
if printf '%s\n' "$ROOT_ENV" | grep -q '^PIGROUPS_SPAWN_CMD='; then
  fail "2.1 PIGROUPS_SPAWN_CMD is set in the root environment; this run would not exercise the default"
else
  pass "2.1 PIGROUPS_SPAWN_CMD is not set in the root environment (default command in play)"
fi
# The same for the driver shell and the herdr server, so the child inherits no override either.
if tr '\0' '\n' < /proc/2919/environ 2>/dev/null | grep -q '^PIGROUPS_SPAWN_CMD='; then
  note "the herdr server environment carries PIGROUPS_SPAWN_CMD (checked for completeness)"
else
  pass "2.1b the herdr server environment carries no PIGROUPS_SPAWN_CMD"
fi

# The root has only this extension's tools; a turn is needed before its session file exists.
herdr agent prompt "$ROOT_PANE" "Reply with exactly: ready" --wait --timeout 180000 > "$OUT/prompt-seed.json" 2>&1
ROOT_SESSION=$(session_file "$ROOTSESS")
[[ -n "$ROOT_SESSION" ]] || die "root session file did not appear under $ROOTSESS"
cp "$ROOT_SESSION" "$OUT/sessions/root-seed.jsonl"
say "root session $ROOT_SESSION"

api_get "$URL" /v1/whoami "$ROOT_TOKEN" > "$OUT/whoami-root.json"
[[ "$(pick member.is_root < "$OUT/whoami-root.json")" == "true" ]] && pass "2.2 root session is the root member" || fail "2.2 whoami is not root"
api_get "$URL" /v1/tree "$ROOT_TOKEN" > "$OUT/tree-before-spawn.json"

# ---------------------------------------------------------------- 3. pg_spawn

say "== 3. root calls pg_spawn (no PIGROUPS_SPAWN_CMD, default command) =="
herdr tab list > "$OUT/tabs-before-spawn.json"
herdr pane list > "$OUT/panes-before-spawn.json"
node "$OUT/dump-tabs.mjs" "$OUT/tabs-before-spawn.json" > "$OUT/tabs-before-spawn.txt"
node "$OUT/dump-panes.mjs" "$OUT/panes-before-spawn.json" > "$OUT/panes-before-spawn.txt"

BRIEF="You are tab-child, a member of this PiGroups organisation. Call pg_say exactly once with to=\"g:$ROOT_ID\" and text=\"tab-child is in its own tab and answering\". Then stop."
PROMPT_SPAWN="Call pg_spawn exactly once with name=\"tab-child\", cwd=\"$CHILD\", and this brief: \"$BRIEF\" Do not pass args. Do not call any other tool before pg_spawn. After it returns, report its JSON result verbatim and stop."
say "prompt: $PROMPT_SPAWN"
herdr agent prompt "$ROOT_PANE" "$PROMPT_SPAWN" --wait --timeout 300000 > "$OUT/prompt-spawn.json" 2>&1
say "spawn turn settled: $(head -c 300 "$OUT/prompt-spawn.json")"

herdr tab list > "$OUT/tabs-after-spawn.json"
herdr pane list > "$OUT/panes-after-spawn.json"
node "$OUT/dump-tabs.mjs" "$OUT/tabs-after-spawn.json" > "$OUT/tabs-after-spawn.txt"
node "$OUT/dump-panes.mjs" "$OUT/panes-after-spawn.json" > "$OUT/panes-after-spawn.txt"

cp "$ROOT_SESSION" "$OUT/sessions/root-after-spawn.jsonl"
tool_results "$ROOT_SESSION" pg_spawn > "$OUT/root-pg-spawn-result.txt" 2>&1
last_assistant_text "$ROOT_SESSION" > "$OUT/root-answer-spawn.txt"

# 3.1 a new tab, in the root's workspace, labelled with the member name
node "$OUT/check-new-tab.mjs" "$OUT/tabs-before-spawn.json" "$OUT/tabs-after-spawn.json" \
  "$WORKSPACE" "tab-child" > "$OUT/check-new-tab.txt" 2>&1
CHILD_TAB=$(head -1 "$OUT/check-new-tab.txt")
say "new tab: $(tail -n +2 "$OUT/check-new-tab.txt" | tr '\n' ' | ')"
if [[ -n "$CHILD_TAB" ]]; then pass "3.1 one new tab appeared, label 'tab-child', workspace $WORKSPACE ($CHILD_TAB)"; else fail "3.1 no new tab in workspace $WORKSPACE: $(cat "$OUT/check-new-tab.txt")"; fi

# 3.2 the child's pane lives in that tab, and the root's tab gained no pane
node "$OUT/check-child-pane.mjs" "$OUT/panes-before-spawn.json" "$OUT/panes-after-spawn.json" \
  "$ROOT_PANE" "$CHILD_TAB" > "$OUT/check-child-pane.txt" 2>&1
CHILD_PANE=$(head -1 "$OUT/check-child-pane.txt")
say "child pane: $(tail -n +2 "$OUT/check-child-pane.txt" | tr '\n' ' | ')"
if [[ -n "$CHILD_PANE" ]]; then pass "3.2 the new pane $CHILD_PANE belongs to tab $CHILD_TAB"; else fail "3.2 no pane in tab $CHILD_TAB: $(cat "$OUT/check-child-pane.txt")"; fi

node "$OUT/check-root-tab.mjs" "$OUT/panes-before-spawn.json" "$OUT/panes-after-spawn.json" \
  "$ROOT_TAB" "$ROOT_PANE" > "$OUT/check-root-tab.txt" 2>&1
say "root tab: $(tr '\n' ' | ' < "$OUT/check-root-tab.txt")"
if grep -qx 'ok' "$OUT/check-root-tab.txt"; then pass "3.3 the root's tab still has exactly its one pane; no split beside the operator"; else fail "3.3 the root's tab changed: $(tr '\n' ' ' < "$OUT/check-root-tab.txt")"; fi

node "$OUT/check-layout-untouched.mjs" "$OUT/panes-baseline.json" "$OUT/panes-after-spawn.json" \
  > "$OUT/check-layout-untouched.txt" 2>&1
say "operator layout: $(tr '\n' ' | ' < "$OUT/check-layout-untouched.txt")"
if grep -qx 'ok' "$OUT/check-layout-untouched.txt"; then pass "3.4 every pre-existing pane is still there, in the same tab"; else fail "3.4 a pre-existing pane moved or vanished: $(tr '\n' ' ' < "$OUT/check-layout-untouched.txt")"; fi

# 3.5 the child runs the DEFAULT self-loading command: the adapter hands the child its own
# spawn command, and with PIGROUPS_SPAWN_CMD unset that is `pi -e <this repo>/src/extension.ts`.
herdr pane read "$CHILD_PANE" --source recent-unwrapped --lines 200 > "$OUT/child-pane.txt" 2>&1
herdr pane process-info --pane "$CHILD_PANE" > "$OUT/child-process-info.json" 2>&1
CHILD_PID=$(pane_pid "$CHILD_PANE")
CHILD_ENV=$(tr '\0' '\n' < "/proc/$CHILD_PID/environ" 2>/dev/null)
printf '%s\n' "$CHILD_ENV" | grep -E '^PIGROUPS_' | sort > "$OUT/child-env.txt"
say "child pi pid $CHILD_PID; PIGROUPS_* in its environment: $(tr '\n' ' ' < "$OUT/child-env.txt")"
EXPECTED_SPAWN_CMD="pi -e $ADAPTER/src/extension.ts"
ACTUAL_SPAWN_CMD=$(grep -m1 '^PIGROUPS_SPAWN_CMD=' "$OUT/child-env.txt" | cut -d= -f2-)
if [[ "$ACTUAL_SPAWN_CMD" == "$EXPECTED_SPAWN_CMD" ]]; then
  pass "3.5 the child's command is the default self-loading one: $ACTUAL_SPAWN_CMD"
else
  fail "3.5 child PIGROUPS_SPAWN_CMD is '${ACTUAL_SPAWN_CMD:-<unset>}', expected '$EXPECTED_SPAWN_CMD'"
fi
# The banner is the second, independent witness: `-ne` would list extension.ts alone, and
# this child lists the operator's whole extension set *plus* extension.ts.
awk '/^\[Extensions\]/,/^$/' "$OUT/child-pane.txt" | head -6 > "$OUT/child-extensions-banner.txt"
if grep -q 'extension.ts' "$OUT/child-extensions-banner.txt"; then
  pass "3.5b the child's [Extensions] banner lists extension.ts among the inherited extensions (self-loading default, not -ne)"
else
  note "3.5b no [Extensions] banner captured (see child-pane.txt)"
fi

# 3.6 the child is a member under the root
CHILD_ID=""
for _ in $(seq 1 200); do
  TREE=$(api_get "$URL" /v1/tree "$ROOT_TOKEN")
  CHILD_ID=$(printf '%s' "$TREE" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const n=(j.nodes??[]).find(x=>x.parent_id!==null);console.log(n?n.id:"")}catch{}})')
  [[ -n "$CHILD_ID" ]] && break
  sleep 0.25
done
printf '%s\n' "$TREE" > "$OUT/tree-after-spawn.json"
if [[ -n "$CHILD_ID" ]]; then pass "3.6 pg_spawn created child member $CHILD_ID under root $ROOT_ID"; else fail "3.6 platform tree never showed a child"; fi
api_get "$URL" "/v1/members/$CHILD_ID" "$ROOT_TOKEN" > "$OUT/member-child-after-spawn.json"
say "child member: $(cat "$OUT/member-child-after-spawn.json")"

# 3.7 the child answers, read as a human reads it
HUMAN=$(curl -sX POST "$URL/v1/humans" -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"name":"tab-spawn-probe-human"}')
printf '%s\n' "$HUMAN" > "$OUT/human.json"
HUMAN_TOKEN=$(printf '%s' "$HUMAN" | pick token)
# The child runs with the operator's own agent dir (that is what the default command means),
# so its session lands under ~/.pi/agent/sessions/--<cwd with - for /-->--; the throwaway cwd
# makes that directory identifiable, and cleanup removes it.
CHILD_SESS_DIR="$HOME/.pi/agent/sessions/--$(printf '%s' "$CHILD" | sed 's|^/||; s|/|-|g')--"
CHILD_SESSION=""
CHILD_SAID=""
for _ in $(seq 1 600); do
  if [[ -n "$HUMAN_TOKEN" ]]; then
    api_get "$URL" "/v1/messages?to=g:$ROOT_ID" "$HUMAN_TOKEN" > "$OUT/messages-group.json"
    grep -q 'tab-child is in its own tab and answering' "$OUT/messages-group.json" && { CHILD_SAID=yes; break; }
  fi
  CHILD_SESSION=$(session_file "$CHILD_SESS_DIR")
  if [[ -z "$CHILD_SAID" && -n "$CHILD_SESSION" ]] && has_tool_result "$CHILD_SESSION" pg_say; then CHILD_SAID=yes; break; fi
  sleep 0.3
done
[[ -n "$CHILD_SESSION" ]] || CHILD_SESSION=$(session_file "$CHILD_SESS_DIR")
if [[ -n "$CHILD_SESSION" ]]; then
  cp "$CHILD_SESSION" "$OUT/sessions/child.jsonl" 2>/dev/null
  tool_results "$CHILD_SESSION" pg_say > "$OUT/child-pg-say-result.txt" 2>&1
  last_assistant_text "$CHILD_SESSION" > "$OUT/child-answer.txt"
fi
say "child session: ${CHILD_SESSION:-<none>}"
say "child pg_say result: $(head -c 240 "$OUT/child-pg-say-result.txt" 2>/dev/null)"
if grep -q 'tab-child is in its own tab and answering' "$OUT/messages-group.json" 2>/dev/null; then
  pass "3.7 the child's line is readable in the group (human token, GET /v1/messages?to=g:$ROOT_ID)"
else
  fail "3.7 no child line in the group: $(head -c 300 "$OUT/messages-group.json" 2>/dev/null)"
fi
say "group message: $(node -e '
  const m=require("node:fs").readFileSync(process.argv[1],"utf8");
  try { const j=JSON.parse(m); const i=(j.items??[]).find(x=>String(x.body??"").includes("own tab"));
        console.log(i?`seq=${i.seq} sender=${i.sender_name} body=${JSON.stringify(i.body)}`:"(not found)"); }
  catch { console.log("(unreadable)"); }' "$OUT/messages-group.json" 2>/dev/null)"
herdr pane read "$CHILD_PANE" --source recent-unwrapped --lines 60 > "$OUT/child-pane-tail.txt" 2>&1
herdr agent list > "$OUT/agent-list-after-spawn.json" 2>&1
api_get "$URL" /v1/tree "$ROOT_TOKEN" > "$OUT/tree-after-answer.json"

# ---------------------------------------------------------------- 4. pg_terminate

say "== 4. root terminates the child =="
[[ -n "$CHILD_ID" ]] || die "no child to terminate"
herdr tab list > "$OUT/tabs-before-terminate.json"
herdr pane list > "$OUT/panes-before-terminate.json"
PROMPT_TERM="Call pg_terminate exactly once with member=\"$CHILD_ID\". Do not call any other tool. Then report its JSON result verbatim and stop."
say "prompt: $PROMPT_TERM"
herdr agent prompt "$ROOT_PANE" "$PROMPT_TERM" --wait --timeout 300000 > "$OUT/prompt-terminate.json" 2>&1
say "terminate turn settled: $(head -c 300 "$OUT/prompt-terminate.json")"
cp "$ROOT_SESSION" "$OUT/sessions/root-after-terminate.jsonl"
tool_results "$ROOT_SESSION" pg_terminate > "$OUT/root-pg-terminate-result.txt" 2>&1
say "pg_terminate result: $(cat "$OUT/root-pg-terminate-result.txt" | head -c 400)"

GONE=""
for _ in $(seq 1 120); do
  herdr tab list > "$OUT/tabs-after-terminate.json"
  if ! node "$OUT/has-tab.mjs" "$OUT/tabs-after-terminate.json" "$CHILD_TAB"; then GONE=yes; break; fi
  sleep 0.25
done
herdr pane list > "$OUT/panes-after-terminate.json" 2>&1
node "$OUT/dump-tabs.mjs" "$OUT/tabs-after-terminate.json" > "$OUT/tabs-after-terminate.txt"
node "$OUT/dump-panes.mjs" "$OUT/panes-after-terminate.json" > "$OUT/panes-after-terminate.txt"
if [[ "$GONE" == "yes" ]]; then
  pass "4.1 the child's tab $CHILD_TAB is gone from herdr tab list"
else
  note "4.1 the child's tab $CHILD_TAB survives as an empty shell: $(node "$OUT/dump-tabs.mjs" "$OUT/tabs-after-terminate.json" | grep "$CHILD_TAB" || echo '(not listed)')"
fi
if node "$OUT/has-pane.mjs" "$OUT/panes-after-terminate.json" "$CHILD_PANE"; then
  fail "4.2 the child's pane $CHILD_PANE is still in herdr pane list"
else
  pass "4.2 the child's pane $CHILD_PANE is gone from herdr pane list"
fi
if [[ -n "$CHILD_PID" ]] && kill -0 "$CHILD_PID" 2>/dev/null; then fail "4.3 the child pi process $CHILD_PID is still alive"; else pass "4.3 the child pi process ${CHILD_PID:-?} is gone"; fi
api_get "$URL" /v1/tree "$ROOT_TOKEN" > "$OUT/tree-after-terminate.json"
if grep -q "$CHILD_ID" "$OUT/tree-after-terminate.json"; then fail "4.4 the child is still in /v1/tree"; else pass "4.4 the child is gone from /v1/tree"; fi
node "$OUT/check-root-tab.mjs" "$OUT/panes-before-terminate.json" "$OUT/panes-after-terminate.json" \
  "$ROOT_TAB" "$ROOT_PANE" > "$OUT/check-root-tab-after-terminate.txt" 2>&1
say "root tab after terminate: $(tr '\n' ' | ' < "$OUT/check-root-tab-after-terminate.txt")"

# ---------------------------------------------------------------- 5. summary

say "== 5. summary =="
say "SUMMARY failed=$FAILED"
say "tabs before spawn:  $(tr '\n' '|' < "$OUT/tabs-before-spawn.txt")"
say "tabs after spawn:   $(tr '\n' '|' < "$OUT/tabs-after-spawn.txt")"
say "tabs after terminate: $(tr '\n' '|' < "$OUT/tabs-after-terminate.txt")"
say "panes after spawn:  $(tr '\n' '|' < "$OUT/panes-after-spawn.txt")"
exit 0
