#!/usr/bin/env bash
# Runs one probe session in the current pane. Started by run.sh; a human can
# also run it by hand inside a spare pane with the env below set.
#
# Required env: PROBE_DIR, PROBE_EXT
# Optional env: PROBE_LOG, PROBE_PROVIDER, PROBE_MODEL, PROBE_SEED_PROMPT,
#               PROBE_ABORT_WAIT_MS
#
# The pi process writes its own pid to $PROBE_DIR/pi.pid and its exit code to
# $PROBE_DIR/exit_code, so the runner can drive P2 (abort file) and P3 (SIGTERM)
# without owning the terminal.
set -uo pipefail

: "${PROBE_DIR:?PROBE_DIR is required}"
: "${PROBE_EXT:?PROBE_EXT is required (absolute path to probe.ts)}"

cd "$PROBE_DIR" || exit 2

args=(
  -ne
  -e "$PROBE_EXT"
  --no-session
  --no-builtin-tools
  --no-mcp
  --no-skills
  --no-prompt-templates
  --no-context-files
)
if [[ -n "${PROBE_PROVIDER:-}" ]]; then args+=(--provider "$PROBE_PROVIDER"); fi
if [[ -n "${PROBE_MODEL:-}" ]]; then args+=(--model "$PROBE_MODEL"); fi

# $BASHPID inside the subshell is the pid that `exec pi` keeps, so pi.pid stays
# valid after the exec.
(
  echo "$BASHPID" > "$PROBE_DIR/pi.pid"
  exec pi "${args[@]}" "${PROBE_SEED_PROMPT:-Reply with exactly: ready}"
)
code=$?

echo "$code" > "$PROBE_DIR/exit_code"
echo "[probe] pi exited with code $code"
