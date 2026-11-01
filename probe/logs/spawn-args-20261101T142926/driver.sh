#!/usr/bin/env bash
# Run B of the spawn-args probe. Same two cases as run A
# (../spawn-args-20261101T142109), with the two gaps of run A closed:
#
#   1. the launch line is read from the child pane's own scrollback, after the
#      child pi exits: herdr types the launch command into the pane's shell, so the
#      shell echoes it. That is the literal command line — base command plus the
#      caller's raw `args` — for both cases.
#   2. the root's and the children's session files are copied at the end: pi does
#      not create a session file until the first turn, so run A's early `find`
#      missed the root's transcript.
#
# Still no PIGROUPS_SPAWN_CMD anywhere: the default is the subject.
set -uo pipefail

OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stamp() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
say() { printf '[spawn-args-B] %s %s\n' "$(stamp)" "$*" | tee -a "$OUT/run.txt"; }
die() { say "FATAL: $*"; exit 2; }

ADAPTER=/home/yang/Documents/pigroups-adapter
PG=/home/yang/Documents/PiGroups
PORT=41778
URL="http://127.0.0.1:$PORT"
MODEL=deepseek/deepseek-flash
EXT="$ADAPTER/src/extension.ts"
READ_TARGET="$ADAPTER/package.json"

unset PIGROUPS_SPAWN_CMD PIGROUPS_URL PIGROUPS_TOKEN PIGROUPS_ADAPTER_DIR
[[ -z "${PIGROUPS_SPAWN_CMD:-}" ]] || die "PIGROUPS_SPAWN_CMD is set; the default is what is under test"

DATA=$(mktemp -d /tmp/pgargsB-data.XXXXXX)
ADIR=$(mktemp -d /tmp/pgargsB-adir.XXXXXX)
SCRATCH=$(mktemp -d /tmp/pgargsB-scratch.XXXXXX)
ROOTSESS=$(mktemp -d /tmp/pgargsB-rootsess.XXXXXX)
CTRLSESS=$(mktemp -d /tmp/pgargsB-ctrlsess.XXXXXX)

PLATFORM_PID=""
TAB_ID=""
CTRL_TAB_ID=""
ROOT_PANE=""
CTRL_PANE=""
P1_PANE=""
P2_PANE=""
ROOT_PID=""
P1_PID=""
P2_PID=""
BANNER_PID=""

kill_pi() { # pid
  local pid=$1
  [[ -z "$pid" ]] && return 0
  kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 1 200); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  say "pid $pid did not exit within 20 s"
  return 1
}
copy_sessions() {
  local dir files file i=0
  dir=$(find "$HOME/.pi/agent/sessions" -maxdepth 1 -type d -name '*pgargsB-scratch*' | head -1)
  if [[ -n "$dir" ]]; then
    files=$(find "$dir" -name '*.jsonl' | sort)
    say "children session dir $dir"
    for file in $files; do
      i=$((i + 1))
      case "$i" in
        1) cp "$file" "$OUT/child1-session.jsonl"; say "child1 session: $file" ;;
        2) cp "$file" "$OUT/child2-session.jsonl"; say "child2 session: $file" ;;
        *) say "unexpected extra session file: $file" ;;
      esac
    done
  fi
  if [[ -n "$CTRL_SESSION" && -f "$CTRL_SESSION" ]]; then cp "$CTRL_SESSION" "$OUT/control-session.jsonl"; say "control session: $CTRL_SESSION"; fi
  if [[ -n "$ROOT_SESSION" && -f "$ROOT_SESSION" ]]; then cp "$ROOT_SESSION" "$OUT/root-session.jsonl"; say "root session: $ROOT_SESSION"; fi
}

cleanup() {
  local status=$?
  set +e
  say "== cleanup =="
  touch "$OUT/stop-banner"
  if [[ -n "$BANNER_PID" ]]; then wait "$BANNER_PID" 2>/dev/null; say "banner watcher stopped"; fi

  kill_pi "$ROOT_PID" || say "root pi $ROOT_PID still alive"
  ROOT_SESSION=$(find "$ROOTSESS" -name '*.jsonl' 2>/dev/null | head -1)
  CTRL_SESSION=$(find "$CTRLSESS" -name '*.jsonl' 2>/dev/null | head -1)
  copy_sessions

  for pane in "$P1_PANE" "$P2_PANE" "$CTRL_PANE" "$ROOT_PANE"; do
    if [[ -n "$pane" ]]; then
      herdr pane close "$pane" >/dev/null 2>&1
      say "closed pane $pane (exit $?)"
    fi
  done
  for tab in "$CTRL_TAB_ID" "$TAB_ID"; do
    if [[ -n "$tab" ]]; then
      herdr tab close "$tab" >/dev/null 2>&1
      say "closed tab $tab (exit $?)"
    fi
  done

  if [[ -n "$PLATFORM_PID" ]]; then
    kill "$PLATFORM_PID" 2>/dev/null
    wait "$PLATFORM_PID" 2>/dev/null
    if kill -0 "$PLATFORM_PID" 2>/dev/null; then say "platform $PLATFORM_PID STILL ALIVE"; else say "platform $PLATFORM_PID stopped"; fi
  fi

  herdr pane list > "$OUT/panes-after-cleanup.json" 2>&1
  herdr tab list > "$OUT/tabs-after-cleanup.json" 2>&1
  node "$OUT/panes.mjs" "$OUT/panes-baseline.json" "$OUT/panes-after-cleanup.json" > "$OUT/panes-new-after-cleanup.txt" 2>&1
  say "new panes vs baseline after cleanup: '$(tr '\n' ' ' < "$OUT/panes-new-after-cleanup.txt")'"
  node -e '
const fs = require("node:fs");
const ids = (f) => JSON.parse(fs.readFileSync(f, "utf8")).result.panes.map((p) => p.pane_id).sort();
console.log("pane sets equal:", JSON.stringify(ids(process.argv[1])) === JSON.stringify(ids(process.argv[2])));
' "$OUT/panes-baseline.json" "$OUT/panes-after-cleanup.json" | tee -a "$OUT/panes-new-after-cleanup.txt"
  node -e '
const fs = require("node:fs");
const ids = (f) => JSON.parse(fs.readFileSync(f, "utf8")).result.tabs.map((t) => t.tab_id).sort();
console.log("tab sets equal:", JSON.stringify(ids(process.argv[1])) === JSON.stringify(ids(process.argv[2])));
' "$OUT/tabs-baseline.json" "$OUT/tabs-after-cleanup.json" | tee -a "$OUT/tabs-after-cleanup.txt"
  curl -sS --max-time 2 "$URL/v1/health" > /dev/null 2>&1 && say "platform still answers on $PORT" || say "platform port $PORT closed"

  local dir
  for dir in "$HOME"/.pi/agent/sessions/*pgargsB-scratch*; do
    if [[ -d "$dir" ]]; then
      cp -r "$dir" "$OUT/children-session-originals" 2>/dev/null
      rm -rf "$dir"
      say "removed $dir (copied to children-session-originals)"
    fi
  done

  rm -rf "$DATA" "$ADIR" "$SCRATCH" "$ROOTSESS" "$CTRLSESS"
  say "driver exit $status"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

pane_session() { herdr pane get "$1" | node "$OUT/jget.mjs" result.pane.agent_session.value; }
pane_pi_pid() {
  herdr pane process-info --pane "$1" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let j;
  try { j = JSON.parse(s); } catch { console.log(""); return; }
  const list = j?.result?.process_info?.foreground_processes ?? [];
  const pi = list.find((p) => p.name === "pi");
  console.log(pi ? String(pi.pid) : "");
});'
}
wait_pane_pi() {
  local pane=$1 pid=""
  for _ in $(seq 1 600); do
    pid=$(pane_pi_pid "$pane")
    if [[ -n "$pid" ]]; then printf '%s' "$pid"; return 0; fi
    sleep 0.1
  done
  return 1
}
api_get() { curl -sS "$URL$1" -H "Authorization: Bearer $2"; }

say "== 0. baseline =="
{
  echo "adapter commit: $(git -C "$ADAPTER" rev-parse HEAD)"
  sha256sum "$ADAPTER/src/extension.ts" "$ADAPTER/src/command.ts" "$ADAPTER/src/herdr.ts"
  echo "adapter status:"; git -C "$ADAPTER" status --porcelain
  echo "platform package version: $(node -e 'console.log(require("'"$PG"'/package.json").version)')"
  echo "pi: $(pi --version 2>&1)"; echo "herdr: $(herdr --version 2>&1 | head -1)"; echo "node: $(node --version)"
} > "$OUT/tree.txt"
say "commit $(git -C "$ADAPTER" rev-parse --short HEAD) / pi $(pi --version 2>&1) / herdr $(herdr --version 2>&1 | head -1)"
cat "$OUT/tree.txt"
herdr pane list > "$OUT/panes-baseline.json"
herdr tab list > "$OUT/tabs-baseline.json"
say "baseline panes: $(node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));console.log(j.result.panes.map(p=>p.pane_id).join(" "))' "$OUT/panes-baseline.json")"
say "baseline tabs:  $(node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));console.log(j.result.tabs.map(t=>t.tab_id).join(" "))' "$OUT/tabs-baseline.json")"

say "== 1. throwaway platform (0.2.0, port $PORT, data $DATA) =="
( cd "$PG" && PIGROUPS_ADMIN_TOKEN=adm PORT=$PORT PIGROUPS_DATA=$DATA node src/main.ts ) > "$OUT/platform.txt" 2>&1 &
PLATFORM_PID=$!
for _ in $(seq 1 100); do curl -sf "$URL/v1/health" >/dev/null && break; sleep 0.1; done
curl -sf "$URL/v1/health" > "$OUT/health.json" || die "platform did not become healthy: $(cat "$OUT/platform.txt")"
say "platform pid $PLATFORM_PID healthy: $(cat "$OUT/health.json")"

ROOT=$(curl -sS -X POST "$URL/v1/bootstrap" -H 'content-type: application/json' -d '{"name":"root"}')
printf '%s' "$ROOT" > "$OUT/bootstrap.json"
ROOT_ID=$(printf '%s' "$ROOT" | node "$OUT/jget.mjs" member.id)
ROOT_TOKEN=$(printf '%s' "$ROOT" | node "$OUT/jget.mjs" token)
[[ -n "$ROOT_ID" && -n "$ROOT_TOKEN" ]] || die "bootstrap failed: $ROOT"
say "root member $ROOT_ID"

HUMAN=$(curl -sS -X POST "$URL/v1/humans" -H 'Authorization: Bearer adm' -H 'content-type: application/json' -d '{"name":"spawn-args-probe-b"}')
printf '%s' "$HUMAN" > "$OUT/human.json"
HUMAN_TOKEN=$(printf '%s' "$HUMAN" | node "$OUT/jget.mjs" token)
[[ -n "$HUMAN_TOKEN" ]] || die "human token failed: $HUMAN"

say "== 2. probe tab, root pi (root isolated with -ne -e) =="
WS=$(herdr workspace list | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const j = JSON.parse(s);
  const list = j?.result?.workspaces ?? [];
  const focused = list.find((w) => w.focused) ?? list[0];
  console.log(focused?.workspace_id ?? "");
});')
[[ -n "$WS" ]] || die "no herdr workspace"
CREATE=$(herdr tab create --workspace "$WS" --cwd "$SCRATCH" --label spawn-args-probe-b \
  --env "PIGROUPS_URL=$URL" \
  --env "PIGROUPS_TOKEN=$ROOT_TOKEN" \
  --env "PIGROUPS_ADAPTER_DIR=$ADIR" \
  --no-focus)
printf '%s\n' "$CREATE" > "$OUT/tab-root.json"
TAB_ID=$(printf '%s' "$CREATE" | grep -o '"tab_id":"[^"]*"' | head -1 | cut -d'"' -f4)
ROOT_PANE=$(printf '%s' "$CREATE" | grep -o '"pane_id":"[^"]*"' | head -1 | cut -d'"' -f4)
[[ -n "$TAB_ID" && -n "$ROOT_PANE" ]] || die "tab create gave no ids: $CREATE"
say "probe tab $TAB_ID, root pane $ROOT_PANE (not focused)"
for _ in $(seq 1 60); do
  herdr pane process-info --pane "$ROOT_PANE" | grep -qE '"name":"(bash|zsh|sh|fish|dash)"' && break
  sleep 0.25
done
herdr agent start root --kind pi --pane "$ROOT_PANE" --timeout 180000 \
  -- -ne -e "$EXT" --model "$MODEL" --session-dir "$ROOTSESS" \
  > "$OUT/agent-start-root.json" 2>&1
say "herdr's reply for the root argv: $(node "$OUT/jget.mjs" result.argv < "$OUT/agent-start-root.json")"
herdr agent wait "$ROOT_PANE" --until idle --timeout 180000 > "$OUT/wait-root.json" 2>&1
ROOT_PID=$(wait_pane_pi "$ROOT_PANE") || die "root pane has no pi process"
say "root idle, pid $ROOT_PID"
tr '\0' '\n' < "/proc/$ROOT_PID/environ" 2>/dev/null | grep -E '^(PIGROUPS|HERDR_PANE_ID)' | sort > "$OUT/root-environ.txt"
cat "$OUT/root-environ.txt"
grep -q '^PIGROUPS_SPAWN_CMD=' "$OUT/root-environ.txt" && die "the root has PIGROUPS_SPAWN_CMD set"
say "root has no PIGROUPS_SPAWN_CMD → the default spawn command is in effect"

node -e '
const fs = require("node:fs");
const ids = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result.panes.map((p) => p.pane_id);
ids.push(process.argv[2]);
fs.writeFileSync(process.argv[3], ids.join("\n") + "\n");
' "$OUT/panes-baseline.json" "$ROOT_PANE" "$OUT/known-panes.txt"
rm -f "$OUT/stop-banner"
node "$OUT/banner-watch.mjs" "$OUT" "$OUT/known-panes.txt" "$OUT/stop-banner" &
BANNER_PID=$!
say "banner watcher pid $BANNER_PID"

# After a child pi exits, its pane's scrollback shows the command line herdr typed
# into the pane's shell: the literal launch command. This is the strongest record of
# the child's argv on this machine (pi's own process title hides the real argv).
read_launch_line() { # pane, outfile
  herdr pane read "$1" --source recent-unwrapped --lines 400 > "$2" 2>&1
  herdr pane read "$1" --source recent --lines 400 >> "$2" 2>&1
  herdr pane read "$1" --source visible --lines 60 >> "$2" 2>&1
  grep -n 'src/extension.ts' "$2" | head -5
}

say "== 3. CASE 1: pg_spawn with only name and brief =="
herdr pane list > "$OUT/panes-before-spawn1.json"
cat > "$OUT/prompt1.txt" <<EOF
Call the pg_spawn tool exactly once with exactly two parameters: name="probe-one" and brief="You are probe-one. Do exactly two things, then stop. (1) Call the read tool once on $READ_TARGET. (2) Call the pg_say tool once with to=g:$ROOT_ID and text=probe-one: read the manifest. Use no other tool, and do not use intercom." Do not pass cwd, args, or any other parameter. Then stop.
EOF
say "prompt(root, spawn 1): $(cat "$OUT/prompt1.txt")"
herdr agent prompt "$ROOT_PANE" "$(cat "$OUT/prompt1.txt")" --wait --timeout 300000 > "$OUT/prompt-spawn1.json" 2>&1
say "spawn-1 turn settled: $(head -c 200 "$OUT/prompt-spawn1.json")"

P1_ID=""
for _ in $(seq 1 150); do
  TREE=$(api_get /v1/tree "$ROOT_TOKEN")
  P1_ID=$(printf '%s' "$TREE" | node "$OUT/tree-find.mjs" probe-one)
  [[ -n "$P1_ID" ]] && break
  sleep 0.2
done
[[ -n "$P1_ID" ]] || die "probe-one never appeared in /v1/tree"
printf '%s\n' "$TREE" > "$OUT/tree-after-spawn1.json"
say "probe-one member $P1_ID"

herdr pane list > "$OUT/panes-after-spawn1.json"
P1_PANE=$(node "$OUT/panes.mjs" "$OUT/panes-before-spawn1.json" "$OUT/panes-after-spawn1.json" "$ROOT_PANE" | head -1)
[[ -n "$P1_PANE" ]] || die "no new pane after spawn 1"
say "probe-one pane $P1_PANE"
herdr pane get "$P1_PANE" > "$OUT/pane1.json"
P1_SESSION=$(pane_session "$P1_PANE")
say "probe-one session: $P1_SESSION"
P1_PID=$(wait_pane_pi "$P1_PANE") || die "probe-one pane has no pi process"
say "probe-one pi pid $P1_PID"
herdr pane process-info --pane "$P1_PANE" > "$OUT/process1.json"
{
  echo "== herdr pane process-info =="; cat "$OUT/process1.json"
  echo "== /proc/$P1_PID/cmdline (od -c) =="; od -c "/proc/$P1_PID/cmdline" 2>&1
  echo "== /proc/$P1_PID/environ (PIGROUPS/HERDR) =="; tr '\0' '\n' < "/proc/$P1_PID/environ" 2>/dev/null | grep -E '^(PIGROUPS|HERDR_PANE_ID)' | sort
} > "$OUT/child1-launch-evidence.txt" 2>&1
cat "$OUT/child1-launch-evidence.txt"

say "waiting for probe-one to call pg_say"
for _ in $(seq 1 900); do
  [[ -n "$P1_SESSION" && -f "$P1_SESSION" ]] && grep -q '"toolName":"pg_say"' "$P1_SESSION" 2>/dev/null && break
  sleep 0.2
done
grep -q '"toolName":"pg_say"' "$P1_SESSION" 2>/dev/null || say "WARNING: no pg_say in probe-one's session"
sleep 1
cp "$P1_SESSION" "$OUT/child1-session.live.jsonl" 2>/dev/null
node "$OUT/session-facts.mjs" "$P1_SESSION" "$OUT/child1-facts" > "$OUT/child1-facts.console.txt" 2>&1
say "probe-one facts (first turn):"; cat "$OUT/child1-facts.txt"

api_get "/v1/messages?to=g:$ROOT_ID&limit=50" "$HUMAN_TOKEN" > "$OUT/human-messages-group-root.json"
api_get "/v1/conversations" "$HUMAN_TOKEN" > "$OUT/human-conversations.json"
say "human view of g:$ROOT_ID:"
node -e '
const fs = require("node:fs");
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const m of j.items ?? []) console.log(`  seq=${m.seq} ${m.sender_name} (${m.sender_kind}): ${JSON.stringify(m.body)}`);
' "$OUT/human-messages-group-root.json" | tee "$OUT/human-view.txt"

say "kill probe-one's pi so the pane's shell scrollback is readable, then read the launch line"
herdr pane read "$P1_PANE" --source visible --lines 40 > "$OUT/pane1-visible.txt" 2>&1 || true
kill_pi "$P1_PID" || say "probe-one pi did not exit cleanly"
sleep 0.5
say "launch line in probe-one's pane scrollback:"
read_launch_line "$P1_PANE" "$OUT/child1-pane-scrollback.txt" | tee -a "$OUT/child1-launch-line.txt"
herdr pane list > "$OUT/panes-after-child1-exit.json"

say "== 4. CASE 2: pg_spawn with args [\"--tools\",\"read\"] =="
herdr pane list > "$OUT/panes-before-spawn2.json"
cat > "$OUT/prompt2.txt" <<EOF
Call the pg_spawn tool exactly once with exactly three parameters: name="probe-two", args=["--tools", "read"], and brief="You are probe-two. Wait for a follow-up instruction, then answer it briefly and exactly." Do not pass cwd or any other parameter. Then stop.
EOF
say "prompt(root, spawn 2): $(cat "$OUT/prompt2.txt")"
herdr agent prompt "$ROOT_PANE" "$(cat "$OUT/prompt2.txt")" --wait --timeout 300000 > "$OUT/prompt-spawn2.json" 2>&1
say "spawn-2 turn settled: $(head -c 200 "$OUT/prompt-spawn2.json")"

P2_ID=""
for _ in $(seq 1 150); do
  TREE=$(api_get /v1/tree "$ROOT_TOKEN")
  P2_ID=$(printf '%s' "$TREE" | node "$OUT/tree-find.mjs" probe-two)
  [[ -n "$P2_ID" ]] && break
  sleep 0.2
done
[[ -n "$P2_ID" ]] || die "probe-two never appeared in /v1/tree"
printf '%s\n' "$TREE" > "$OUT/tree-after-spawn2.json"
say "probe-two member $P2_ID"

herdr pane list > "$OUT/panes-after-spawn2.json"
P2_PANE=$(node "$OUT/panes.mjs" "$OUT/panes-before-spawn2.json" "$OUT/panes-after-spawn2.json" "$ROOT_PANE" "$P1_PANE" | head -1)
[[ -n "$P2_PANE" ]] || die "no new pane after spawn 2"
say "probe-two pane $P2_PANE"
herdr pane get "$P2_PANE" > "$OUT/pane2.json"
P2_SESSION=$(pane_session "$P2_PANE")
say "probe-two session: $P2_SESSION"
P2_PID=$(wait_pane_pi "$P2_PANE") || die "probe-two pane has no pi process"
say "probe-two pi pid $P2_PID"
herdr pane process-info --pane "$P2_PANE" > "$OUT/process2.json"
{
  echo "== herdr pane process-info =="; cat "$OUT/process2.json"
  echo "== /proc/$P2_PID/cmdline (od -c) =="; od -c "/proc/$P2_PID/cmdline" 2>&1
  echo "== /proc/$P2_PID/environ (PIGROUPS/HERDR) =="; tr '\0' '\n' < "/proc/$P2_PID/environ" 2>/dev/null | grep -E '^(PIGROUPS|HERDR_PANE_ID)' | sort
} > "$OUT/child2-launch-evidence.txt" 2>&1
cat "$OUT/child2-launch-evidence.txt"

herdr agent wait "$P2_PANE" --until idle --timeout 300000 > "$OUT/wait-child2.json" 2>&1
say "probe-two idle: $(head -c 160 "$OUT/wait-child2.json")"
cat > "$OUT/prompt2-bash.txt" <<EOF
Use the bash tool to run exactly this command: touch $SCRATCH/bash-ran
then report the verbatim result. If you cannot run it, say exactly which tools you do have available and why the command cannot be run.
EOF
say "prompt(probe-two): $(cat "$OUT/prompt2-bash.txt")"
herdr agent prompt "$P2_PANE" "$(cat "$OUT/prompt2-bash.txt")" --wait --timeout 300000 > "$OUT/prompt-child2-bash.json" 2>&1
say "probe-two bash turn settled: $(head -c 200 "$OUT/prompt-child2-bash.json")"
sleep 1
cp "$P2_SESSION" "$OUT/child2-session.live.jsonl" 2>/dev/null
node "$OUT/session-facts.mjs" "$P2_SESSION" "$OUT/child2-facts" > "$OUT/child2-facts.console.txt" 2>&1
say "probe-two facts:"; cat "$OUT/child2-facts.txt"
if [[ -e "$SCRATCH/bash-ran" ]]; then
  say "bash-ran EXISTS: the command ran"
  ls -l "$SCRATCH/bash-ran" > "$OUT/bash-ran.txt" 2>&1
else
  say "bash-ran absent: the command did not run"
  echo "bash-ran absent" > "$OUT/bash-ran.txt"
fi

say "kill probe-two's pi and read its launch line"
herdr pane read "$P2_PANE" --source visible --lines 40 > "$OUT/pane2-visible.txt" 2>&1 || true
kill_pi "$P2_PID" || say "probe-two pi did not exit cleanly"
sleep 0.5
say "launch line in probe-two's pane scrollback:"
read_launch_line "$P2_PANE" "$OUT/child2-pane-scrollback.txt" | tee -a "$OUT/child2-launch-line.txt"

say "== 5. control: the same pi with -ne (A/B for the extension and tool lists) =="
CTRL_CREATE=$(herdr tab create --workspace "$WS" --cwd "$SCRATCH" --label spawn-args-control-b --no-focus)
printf '%s\n' "$CTRL_CREATE" > "$OUT/tab-control.json"
CTRL_TAB_ID=$(printf '%s' "$CTRL_CREATE" | grep -o '"tab_id":"[^"]*"' | head -1 | cut -d'"' -f4)
CTRL_PANE=$(printf '%s' "$CTRL_CREATE" | grep -o '"pane_id":"[^"]*"' | head -1 | cut -d'"' -f4)
[[ -n "$CTRL_TAB_ID" && -n "$CTRL_PANE" ]] || die "control tab create gave no ids"
for _ in $(seq 1 60); do
  herdr pane process-info --pane "$CTRL_PANE" | grep -qE '"name":"(bash|zsh|sh|fish|dash)"' && break
  sleep 0.25
done
herdr agent start control --kind pi --pane "$CTRL_PANE" --timeout 180000 \
  -- -ne -e "$EXT" --model "$MODEL" --session-dir "$CTRLSESS" \
  > "$OUT/agent-start-control.json" 2>&1
say "control argv per herdr (herdr's own record for a pane the driver started): $(node "$OUT/jget.mjs" result.argv < "$OUT/agent-start-control.json")"
herdr agent wait "$CTRL_PANE" --until idle --timeout 180000 > "$OUT/wait-control.json" 2>&1
sleep 1
herdr pane read "$CTRL_PANE" --source visible --lines 60 > "$OUT/control-banner.txt" 2>&1
say "control banner:"; cat "$OUT/control-banner.txt"

say "== 6. done; cleanup follows =="
