#!/usr/bin/env bash
# Follow-up to both runs: why did `pg_spawn` report "timed out waiting for agent
# status" for two perfectly healthy children?
#
# HerdrCli.waitReady() runs `herdr agent wait <pane> --until idle`. This probe shows
# what herdr reports for a normal pi after it has finished one turn, and what each
# `--until` value matches when the agent is already settled.
set -uo pipefail
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ready-probe"
mkdir -p "$OUT"
stamp() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
say() { printf '[ready] %s %s\n' "$(stamp)" "$*" | tee -a "$OUT/run.txt"; }
ADAPTER=/home/yang/Documents/pigroups-adapter
EXT="$ADAPTER/src/extension.ts"
S=$(mktemp -d /tmp/pgargs-ready.XXXXXX)
D=$(mktemp -d /tmp/pgargs-readysess.XXXXXX)

cleanup() {
  local status=$?
  set +e
  herdr pane close "$PANE" >/dev/null 2>&1
  herdr tab close "$TAB" >/dev/null 2>&1
  herdr pane list > "$OUT/panes-final.json" 2>&1
  say "final panes: $(node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));console.log(j.result.panes.map(p=>p.pane_id).join(" "))' "$OUT/panes-final.json")"
  rm -rf "$S" "$D"
  exit "$status"
}
trap cleanup EXIT

herdr pane list > "$OUT/panes-baseline.json"
C=$(herdr tab create --cwd "$S" --label spawn-args-ready --no-focus)
TAB=$(printf '%s' "$C" | grep -o '"tab_id":"[^"]*"' | head -1 | cut -d'"' -f4)
PANE=$(printf '%s' "$C" | grep -o '"pane_id":"[^"]*"' | head -1 | cut -d'"' -f4)
say "tab $TAB pane $PANE"
for _ in $(seq 1 60); do
  herdr pane process-info --pane "$PANE" | grep -qE '"name":"(bash|zsh|sh|fish|dash)"' && break
  sleep 0.25
done
herdr agent start ready --kind pi --pane "$PANE" --timeout 180000 \
  -- -ne -e "$EXT" --model deepseek/deepseek-flash --session-dir "$D" > "$OUT/agent-start.json" 2>&1
say "start argv: $(node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify(j.result.argv))' "$OUT/agent-start.json")"

herdr agent wait "$PANE" --until idle --timeout 60000 > "$OUT/wait-before-turn.json" 2>&1
say "before any turn, --until idle: exit=$? $(head -c 200 "$OUT/wait-before-turn.json")"

herdr agent prompt "$PANE" "Reply with exactly: ok" --wait --timeout 120000 > "$OUT/prompt.json" 2>&1
say "prompt done: $(head -c 200 "$OUT/prompt.json")"
sleep 1
herdr pane list > "$OUT/panes-after-turn.json"
say "status after one turn: $(node -e '
const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));
const p=j.result.panes.find(x=>x.pane_id===process.argv[2]);
console.log(`${p?.agent_status} (interactive_ready=${p?.interactive_ready})`);
' "$OUT/panes-after-turn.json" "$PANE")"

herdr pane read "$PANE" --source visible --lines 20 > "$OUT/pane-after-turn.txt" 2>&1

herdr agent wait "$PANE" --until idle --timeout 8000 > "$OUT/wait-done-until-idle.json" 2>&1
say "settled as done, --until idle, 8 s: exit=$? $(head -c 200 "$OUT/wait-done-until-idle.json")"
herdr agent wait "$PANE" --until done --timeout 8000 > "$OUT/wait-done-until-done.json" 2>&1
say "settled as done, --until done, 8 s: exit=$? $(head -c 200 "$OUT/wait-done-until-done.json")"
herdr agent wait "$PANE" --until idle --until done --timeout 8000 > "$OUT/wait-done-until-idle-or-done.json" 2>&1
say "settled as done, --until idle --until done, 8 s: exit=$? $(head -c 200 "$OUT/wait-done-until-idle-or-done.json")"
