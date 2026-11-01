#!/usr/bin/env bash
# A/B for the inheritance claim: the same pi, with `-ne`, after one turn, so its
# session file exists and records the built-in tool list pi enabled.
#
# Case 1's child (spawned by pg_spawn with no `-ne`) lists 15 built-in tools,
# including tools from packages the adapter never loaded. This control shows what
# the same machine produces when discovery is disabled: only the four built-ins.
set -uo pipefail
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/control-probe"
mkdir -p "$OUT"
stamp() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
say() { printf '[control] %s %s\n' "$(stamp)" "$*" | tee -a "$OUT/run.txt"; }
ADAPTER=/home/yang/Documents/pigroups-adapter
EXT="$ADAPTER/src/extension.ts"
S=$(mktemp -d /tmp/pgargs-ctrl.XXXXXX)
D=$(mktemp -d /tmp/pgargs-ctrlsess.XXXXXX)

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
C=$(herdr tab create --cwd "$S" --label spawn-args-control-c --no-focus)
TAB=$(printf '%s' "$C" | grep -o '"tab_id":"[^"]*"' | head -1 | cut -d'"' -f4)
PANE=$(printf '%s' "$C" | grep -o '"pane_id":"[^"]*"' | head -1 | cut -d'"' -f4)
say "tab $TAB pane $PANE"
for _ in $(seq 1 60); do
  herdr pane process-info --pane "$PANE" | grep -qE '"name":"(bash|zsh|sh|fish|dash)"' && break
  sleep 0.25
done
herdr agent start control --kind pi --pane "$PANE" --timeout 180000 \
  -- -ne -e "$EXT" --model deepseek/deepseek-flash --session-dir "$D" > "$OUT/agent-start.json" 2>&1
say "start argv: $(node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify(j.result.argv))' "$OUT/agent-start.json")"
herdr pane read "$PANE" --source visible --lines 60 > "$OUT/banner.txt" 2>&1
say "banner [Extensions]: $(grep -A3 '^\[Extensions\]' "$OUT/banner.txt" | tr '\n' ' ')"
herdr agent prompt "$PANE" "Reply with exactly: ok" --wait --timeout 120000 > "$OUT/prompt.json" 2>&1
say "turn: $(head -c 160 "$OUT/prompt.json")"
sleep 1
SESSION=$(find "$D" -name '*.jsonl' | head -1)
say "control session: $SESSION"
cp "$SESSION" "$OUT/control-session.jsonl"
node "$(dirname "$OUT")/session-facts.mjs" "$OUT/control-session.jsonl" "$OUT/control-facts" > "$OUT/control-facts.console.txt" 2>&1
say "control builtin tools: $(grep '^builtinTools=' "$OUT/control-facts.txt")"
say "control tool calls: $(grep '^toolCalls=' "$OUT/control-facts.txt")"
