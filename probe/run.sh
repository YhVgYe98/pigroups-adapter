#!/usr/bin/env bash
# Real-machine probe for the PiGroups adapter's three pi assumptions.
#
#   P1  sendMessage(..., {triggerTurn:true}) from an agent_settled handler starts a run
#   P2  ctx.abort() cuts a turn that is inside a running tool; isIdle() follows.
#       The default tool cooperates (it returns from its own abort listener); set
#       PROBE_IGNORE_SIGNAL=1 for the hard variant, where the tool ignores the
#       signal and only pi can end the run.
#   P3  session_shutdown handlers run and are awaited before the process exits
#
# What it does:
#   1. creates a NON-focused herdr tab (your layout and focus are left alone)
#   2. starts pi in that pane with probe/probe.ts preloaded and PROBE_LOG/PROBE_DIR set
#   3. waits for P1, drives P2 by touching $PROBE_DIR/abort while probe_sleep runs
#   4. sends SIGTERM for P3 and checks the exit code
#   5. prints the JSONL log and a PASS/FAIL summary, then closes the tab
#
# Usage:   probe/run.sh            (or: PROBE_OUT_DIR=/tmp/p1 probe/run.sh)
# Env:     PROBE_OUT_DIR, PROBE_PROVIDER, PROBE_MODEL, PROBE_SEED_PROMPT,
#          PROBE_ABORT_WAIT_MS (default 3000, the adapter's ABORT_IDLE_TIMEOUT_MS),
#          PROBE_IGNORE_SIGNAL, PROBE_ABORT_DELAY, PROBE_SHUTDOWN_SETTLE_MS,
#          PROBE_SEED_TIMEOUT, PROBE_P1_TIMEOUT, PROBE_P2_TIMEOUT,
#          PROBE_ABORT_TIMEOUT, PROBE_SHUTDOWN_TIMEOUT
#
# Exit code: 0 = every check passed, 1 = at least one check failed, 2 = setup error.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_TS="$HERE/probe.ts"
PANE_SH="$HERE/pane.sh"

say() { printf '[probe] %s\n' "$*" >&2; }
die() { say "ERROR: $*"; exit 2; }

[[ -f "$PROBE_TS" ]] || die "missing $PROBE_TS"
[[ -f "$PANE_SH" ]] || die "missing $PANE_SH"
command -v herdr >/dev/null 2>&1 || die "herdr is not on PATH"
command -v pi >/dev/null 2>&1 || die "pi is not on PATH"
herdr status >/dev/null 2>&1 || die "the herdr server is not running"

OUT_DIR="${PROBE_OUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/pigroups-probe.XXXXXX")}"
mkdir -p "$OUT_DIR"
PROBE_LOG="$OUT_DIR/probe.log"
ABORT_FILE="$OUT_DIR/abort"
PID_FILE="$OUT_DIR/pi.pid"
EXIT_FILE="$OUT_DIR/exit_code"
rm -f "$PROBE_LOG" "$ABORT_FILE" "$PID_FILE" "$EXIT_FILE" "$OUT_DIR"/shutdown_done_* 2>/dev/null || true

# The adapter gives up its own abort wait at ABORT_IDLE_TIMEOUT_MS = 3000; a probe
# that accepted 20 s would pass a turn the adapter had already abandoned.
ABORT_WAIT_MS="${PROBE_ABORT_WAIT_MS:-3000}"
IGNORE_SIGNAL="${PROBE_IGNORE_SIGNAL:-0}"
SHUTDOWN_SETTLE_MS="${PROBE_SHUTDOWN_SETTLE_MS:-3000}"
ABORT_DELAY="${PROBE_ABORT_DELAY:-1.5}"
SEED_TIMEOUT="${PROBE_SEED_TIMEOUT:-120}"
P1_TIMEOUT="${PROBE_P1_TIMEOUT:-120}"
P2_TIMEOUT="${PROBE_P2_TIMEOUT:-120}"
ABORT_TIMEOUT="${PROBE_ABORT_TIMEOUT:-$(( ABORT_WAIT_MS / 1000 + 5 ))}"
SHUTDOWN_TIMEOUT="${PROBE_SHUTDOWN_TIMEOUT:-20}"
# Failure-path bounds. A cooperating tool closes at once; PROBE_IGNORE_SIGNAL=1 needs
# up to the tool's own 60 s timer, so the defaults are sized for that. A synthetic
# negative-control run shrinks them.
TRIGGER_TIMEOUT="${PROBE_TRIGGER_TIMEOUT:-15}"
RESULT_TIMEOUT="${PROBE_RESULT_TIMEOUT:-90}"
RUN4_TIMEOUT="${PROBE_RUN4_TIMEOUT:-30}"
SETTLE4_TIMEOUT="${PROBE_SETTLE4_TIMEOUT:-60}"

PROVIDER="${PROBE_PROVIDER:-${PI_PROVIDER:-}}"
MODEL="${PROBE_MODEL:-${PI_MODEL:-}}"
SEED_PROMPT="${PROBE_SEED_PROMPT:-Reply with exactly: ready}"

TAB_ID=""
PANE_ID=""
FAILED=0

pass() { say "PASS  $*"; }
fail() { say "FAIL  $*"; FAILED=1; }
warn() { say "WARN  $*"; }

cleanup() {
  local status=$?
  set +e
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null
      for _ in $(seq 1 50); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
      kill -KILL "$pid" 2>/dev/null
    fi
  fi
  if [[ -n "$TAB_ID" ]]; then
    herdr tab close "$TAB_ID" >/dev/null 2>&1
  fi
  if [[ "$status" -eq 0 && "$FAILED" -ne 0 ]]; then
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------- log helpers

has_line() { # step [field-fragment]
  [[ -s "$PROBE_LOG" ]] || return 1
  awk -v s="\"step\":\"$1\"" -v f="${2:-}" \
    'index($0, s) && (f == "" || index($0, f)) { found = 1; exit } END { exit found ? 0 : 1 }' \
    "$PROBE_LOG"
}

wait_line() { # step [field-fragment] timeout label
  local step="$1" field="${2:-}" timeout="${3:-30}" label="${4:-$1}"
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    if has_line "$step" "$field"; then return 0; fi
    sleep 0.25
  done
  return 1
}

line_no() { # step [field-fragment]  -> 1-based line number of the first match
  awk -v s="\"step\":\"$1\"" -v f="${2:-}" \
    'index($0, s) && (f == "" || index($0, f)) { print NR; exit }' "$PROBE_LOG" 2>/dev/null
}

str_field() { # step field-name  -> string value of `"field":"..."` on the first matching line
  awk -v s="\"step\":\"$1\"" -v f="\"$2\":\"" '
    index($0, s) {
      if (match($0, f "[^\"]*")) {
        v = substr($0, RSTART + length(f), RLENGTH - length(f))
        print v
      }
      exit
    }' "$PROBE_LOG" 2>/dev/null
}

num_field() { # step field-name [occurrence]  -> numeric value of `"field":N`
  awk -v s="\"step\":\"$1\"" -v f="\"$2\":" -v n="${3:-1}" '
    index($0, s) {
      c++
      if (c == n) {
        if (match($0, f "[0-9]+")) {
          v = substr($0, RSTART, RLENGTH)
          sub(f, "", v)
          print v
        }
        exit
      }
    }' "$PROBE_LOG" 2>/dev/null
}

# ---------------------------------------------------------------- pane setup

WORKSPACE="${HERDR_WORKSPACE_ID:-}"
if [[ -z "$WORKSPACE" ]]; then
  WORKSPACE="$(herdr pane current --current 2>/dev/null \
    | grep -o '"workspace_id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
fi
[[ -n "$WORKSPACE" ]] || die "cannot determine the herdr workspace (set HERDR_WORKSPACE_ID)"

ENV_ARGS=(
  --env "PROBE_LOG=$PROBE_LOG"
  --env "PROBE_DIR=$OUT_DIR"
  --env "PROBE_EXT=$PROBE_TS"
  --env "PROBE_SEED_PROMPT=$SEED_PROMPT"
  --env "PROBE_ABORT_WAIT_MS=$ABORT_WAIT_MS"
  --env "PROBE_IGNORE_SIGNAL=$IGNORE_SIGNAL"
  --env "PROBE_SHUTDOWN_SETTLE_MS=$SHUTDOWN_SETTLE_MS"
  --env "PROBE_PROVIDER=$PROVIDER"
  --env "PROBE_MODEL=$MODEL"
)
# The pane inherits the herdr server's environment, not this shell's. Forward the
# API keys this shell has so the probe uses the same credentials a human does.
for key in DEEPSEEK_API_KEY OPENROUTER_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY \
           ZAI_CODING_CN_API_KEY GLM_API_KEY GEMINI_API_KEY GOOGLE_API_KEY; do
  if [[ -n "${!key:-}" ]]; then
    ENV_ARGS+=(--env "$key=${!key}")
  fi
done

say "output dir : $OUT_DIR"
say "workspace  : $WORKSPACE"
say "provider   : ${PROVIDER:-<pi default>}"
say "model      : ${MODEL:-<pi default>}"
if [[ "$IGNORE_SIGNAL" == "1" ]]; then
  say "abort mode : probe_sleep ignores the signal (hard variant)"
else
  say "abort mode : probe_sleep returns from its own signal listener (control)"
fi
say "abort bound: ${ABORT_WAIT_MS} ms (adapter ABORT_IDLE_TIMEOUT_MS = 3000)"

CREATE_JSON="$(herdr tab create --workspace "$WORKSPACE" --cwd "$OUT_DIR" \
  --label "pigroups-probe" "${ENV_ARGS[@]}" --no-focus)"
TAB_ID="$(printf '%s' "$CREATE_JSON" | grep -o '"tab_id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
PANE_ID="$(printf '%s' "$CREATE_JSON" | grep -o '"pane_id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
[[ -n "$TAB_ID" && -n "$PANE_ID" ]] || die "tab create did not return ids: $CREATE_JSON"
say "tab        : $TAB_ID ($PANE_ID, not focused)"

# Wait until the pane's shell is at a prompt before typing into it.
for _ in $(seq 1 60); do
  info="$(herdr pane process-info --pane "$PANE_ID" 2>/dev/null || true)"
  if printf '%s' "$info" | grep -E '"name":"(bash|zsh|sh|fish|dash)"' >/dev/null; then break; fi
  sleep 0.25
done

herdr pane run "$PANE_ID" bash "$PANE_SH" >/dev/null
say "pi started in the pane; waiting for the seed run"

# ---------------------------------------------------------------- P1

if wait_line settled_1 "" "$SEED_TIMEOUT"; then
  pass "P1.0 the seed run reached agent_settled"
else
  fail "P1.0 no agent_settled within ${SEED_TIMEOUT}s (pi did not finish the seed turn)"
fi

if has_line settled_1 '"isIdle":true'; then
  pass "P1.1 ctx.isIdle() is already true inside the agent_settled handler (A1)"
else
  fail "P1.1 ctx.isIdle() was not true inside agent_settled; the adapter's isBusy() gate stays closed (A1)"
fi

if has_line delivered '"stage":"p1"'; then
  pass "P1.2 sendMessage(..., {triggerTurn:true}) returned from the settle handler"
else
  fail "P1.2 delivered(p1) was never logged"
fi

if wait_line turn_start '"run":2' "$P1_TIMEOUT"; then
  pass "P1.3 a second agent_start appeared"
else
  fail "P1.3 no second agent_start within ${P1_TIMEOUT}s after delivering from agent_settled (A2)"
fi

DELIVERED_LINE="$(line_no delivered '"stage":"p1"')"
SECOND_TURN_LINE="$(line_no turn_start '"run":2')"
CUSTOM_START_LINE="$(line_no before_agent_start '"messageType":"custom"')"

if [[ -n "$DELIVERED_LINE" && -n "$SECOND_TURN_LINE" && "$SECOND_TURN_LINE" -gt "$DELIVERED_LINE" ]]; then
  pass "P1.4 turn_start #2 is after delivered (line $SECOND_TURN_LINE > $DELIVERED_LINE)"
else
  fail "P1.4 turn_start #2 is not after delivered (delivered=$DELIVERED_LINE turn2=$SECOND_TURN_LINE)"
fi

if [[ -n "$CUSTOM_START_LINE" && -n "$DELIVERED_LINE" && "$CUSTOM_START_LINE" -gt "$DELIVERED_LINE" ]]; then
  pass "P1.5 the new run was started by the custom message (before_agent_start messageType=custom)"
else
  fail "P1.5 the new run was not started by a custom message; it may have been steered into another run (A3 trap)"
fi

DELTA="$(num_field turn_start since_delivery_ms 2)"
if [[ -z "$DELTA" ]]; then
  fail "P1.6 turn #2 did not log since_delivery_ms; the delivery-to-start latency is unknown"
elif [[ "$DELTA" -le 1000 ]]; then
  pass "P1.6 turn #2 started ${DELTA} ms after sendMessage returned (bounded by 1000 ms)"
else
  warn "turn #2 started ${DELTA} ms after sendMessage returned (> 1000 ms)"
fi

# ---------------------------------------------------------------- P2

if wait_line settled_2 "" "$P2_TIMEOUT"; then
  pass "P2.0 the P1 turn settled"
else
  fail "P2.0 the P1 turn did not settle within ${P2_TIMEOUT}s"
fi

if has_line delivered '"stage":"p2"'; then
  pass "P2.1 the probe_sleep request was delivered"
else
  fail "P2.1 delivered(p2) was never logged"
fi

if wait_line tool_start '"toolName":"probe_sleep"' "$P2_TIMEOUT"; then
  pass "P2.2 the model called probe_sleep and the tool started"
else
  fail "P2.2 probe_sleep never started (did the model call it?)"
fi

if has_line tool_start '"toolName":"probe_sleep"'; then
  say "tool is running; touching the abort trigger in ${ABORT_DELAY}s"
  sleep "$ABORT_DELAY"
  : > "$ABORT_FILE"
fi

if wait_line abort_seen "" "$TRIGGER_TIMEOUT"; then
  pass "P2.3 the tool saw the external abort trigger"
else
  fail "P2.3 the tool did not see $ABORT_FILE"
fi

if wait_line abort_called "" 5; then
  ABORT_SYNC="$(num_field abort_called abort_sync_ms)"
  if [[ -n "$ABORT_SYNC" && "$ABORT_SYNC" -le 1000 ]]; then
    pass "P2.4 ctx.abort() returned in ${ABORT_SYNC} ms without waiting for the turn (bound 1000 ms)"
  else
    fail "P2.4 abort_called logged but abort_sync_ms is '${ABORT_SYNC:-missing}' (> 1000 ms or absent)"
  fi
else
  fail "P2.4 abort_called was never logged"
fi

TOOL_ENTER_LINE="$(line_no tool_enter '"tool":"probe_sleep"')"
ABORT_SEEN_LINE="$(line_no abort_seen "")"
ABORT_CALLED_LINE="$(line_no abort_called "")"
if [[ -n "$TOOL_ENTER_LINE" && -n "$ABORT_SEEN_LINE" && -n "$ABORT_CALLED_LINE" \
      && "$TOOL_ENTER_LINE" -lt "$ABORT_SEEN_LINE" && "$ABORT_SEEN_LINE" -lt "$ABORT_CALLED_LINE" ]]; then
  pass "P2.3b tool_enter < abort_seen < abort_called (lines $TOOL_ENTER_LINE < $ABORT_SEEN_LINE < $ABORT_CALLED_LINE)"
else
  fail "P2.3b the abort did not arrive after the tool started (tool_enter=$TOOL_ENTER_LINE abort_seen=$ABORT_SEEN_LINE abort_called=$ABORT_CALLED_LINE)"
fi

if wait_line idle "" "$ABORT_TIMEOUT"; then
  IDLE_MS="$(num_field idle wait_ms)"
  # The poller can miss the idle window between settled_3 and the probe's own p3
  # delivery (both happen in one tick). The settle handler reads isIdle() directly,
  # so when it is in the log it is the earlier and more precise observation.
  if has_line settled_3 '"aborted":true'; then
    SETTLED_MS_AT="$(num_field settled_3 ms)"
    ABORT_MS_AT="$(num_field abort_called ms)"
    if [[ -n "$SETTLED_MS_AT" && -n "$ABORT_MS_AT" ]]; then
      SETTLE_DELAY=$(( SETTLED_MS_AT - ABORT_MS_AT ))
      if [[ "$SETTLE_DELAY" -lt "$IDLE_MS" ]]; then IDLE_MS="$SETTLE_DELAY"; fi
    fi
  fi
  if [[ -n "$IDLE_MS" && "$IDLE_MS" -le "$ABORT_WAIT_MS" ]]; then
    pass "P2.5 ctx.isIdle() turned true ${IDLE_MS} ms after the abort call (bound ${ABORT_WAIT_MS} ms; tool ignores signal: $IGNORE_SIGNAL)"
  else
    fail "P2.5 idle after ${IDLE_MS:-?} ms, beyond the ${ABORT_WAIT_MS} ms bound (B2)"
  fi
else
  if has_line idle_timeout; then
    fail "P2.5 idle_timeout: the turn never settled within ${ABORT_WAIT_MS} ms after ctx.abort() (B2 false for this tool, pg.abort would be a lie)"
  else
    fail "P2.5 neither idle nor idle_timeout was logged"
  fi
fi

# P2.6 is pi's bookkeeping, not the cut speed: a cooperating tool ends at the abort,
# a tool that ignores the signal ends on its own timer (60 s at most in this probe).
if wait_line tool_end '"toolName":"probe_sleep"' "$RESULT_TIMEOUT"; then
  TOOL_END_TEXT="$(awk 'index($0, "\"step\":\"tool_end\"") && index($0, "\"toolName\":\"probe_sleep\"") { print; exit }' "$PROBE_LOG" 2>/dev/null || true)"
  # The check is that the end event exists at all; isError is reported as observed,
  # not as a claim about pi replacing the tool's result.
  if [[ "$TOOL_END_TEXT" == *'"isError":true'* ]]; then
    pass "P2.6 tool_execution_end for probe_sleep was emitted (observed isError=true)"
  else
    pass "P2.6 tool_execution_end for probe_sleep was emitted (observed isError=false)"
  fi
else
  fail "P2.6 probe_sleep never emitted tool_execution_end within ${RESULT_TIMEOUT} s of the abort"
fi

# P2.7 is about *when* the aborted settle arrives: the adapter gives up at
# ABORT_IDLE_TIMEOUT_MS and then says nothing, so a settle much later does not make
# pg.abort honest.
ABORT_AT_MS="$(num_field abort_called ms)"
if wait_line settled_3 '"aborted":true' "$RESULT_TIMEOUT"; then
  SETTLED_AT_MS="$(num_field settled_3 ms)"
  if [[ -n "$ABORT_AT_MS" && -n "$SETTLED_AT_MS" ]]; then
    SETTLE_DELAY=$(( SETTLED_AT_MS - ABORT_AT_MS ))
    if [[ "$SETTLE_DELAY" -le "$ABORT_WAIT_MS" ]]; then
      pass "P2.7 agent_settled reports aborted=true ${SETTLE_DELAY} ms after ctx.abort() (bound ${ABORT_WAIT_MS} ms)"
    else
      fail "P2.7 the aborted settle came ${SETTLE_DELAY} ms after ctx.abort(), beyond the ${ABORT_WAIT_MS} ms the adapter waits; pi did not end the run, the tool did"
    fi
  else
    fail "P2.7 aborted settle found but the abort/settle timestamps are missing (abort=${ABORT_AT_MS:-?} settled=${SETTLED_AT_MS:-?})"
  fi
else
  fail "P2.7 no agent_settled with aborted=true within ${RESULT_TIMEOUT} s of the abort"
fi

if has_line tool_start '"toolName":"probe_sleep"'; then
  if has_line before_settle '"outcome":"aborted"'; then
    pass "P2.8 agent_before_settle outcome=aborted was emitted"
  else
    warn "no agent_before_settle for the aborted run -- pi skips that boundary once a run is aborted;" \
         "the adapter now closes the turn from agent_settled.aborted (abecc76), not from this event"
  fi
  LAST_PI_TURN_END="$(awk 'index($0, "\"step\":\"pi_turn_end\"") { line = $0 } END { print line }' "$PROBE_LOG" 2>/dev/null || true)"
  if [[ -n "$LAST_PI_TURN_END" ]]; then
    say "note  last pi_turn_end: $LAST_PI_TURN_END"
  fi
else
  say "note  P2.8 not evaluated: probe_sleep never ran, so there was no aborted run to inspect"
fi

# P2.9 / P2.10: the adapter flushes after an aborted settle, so sendMessage must start
# a run from that path too. P1 only proves the normal-settle path. The delivery happens
# inside the settle handler, so a settled_3 with aborted=true implies delivered(p3).
if has_line settled_3 '"aborted":true' && wait_line delivered '"stage":"p3"' 5; then
  pass "P2.9 sendMessage from an aborted agent_settled handler was accepted (delivered stage=p3)"
else
  fail "P2.9 no delivered(p3) after an aborted settle; the adapter's flush after pg.abort would deliver into nothing"
fi

if wait_line turn_start '"run":4' "$RUN4_TIMEOUT"; then
  pass "P2.10 a new run started after the aborted-settle delivery"
  DELIVERED_P3_LINE="$(line_no delivered '"stage":"p3"')"
  TURN4_LINE="$(line_no turn_start '"run":4')"
  if [[ -n "$DELIVERED_P3_LINE" && -n "$TURN4_LINE" && "$TURN4_LINE" -gt "$DELIVERED_P3_LINE" ]]; then
    pass "P2.10b turn_start #4 is after delivered(p3) (line $TURN4_LINE > $DELIVERED_P3_LINE)"
  else
    fail "P2.10b turn_start #4 is not after delivered(p3) (delivered=$DELIVERED_P3_LINE turn4=$TURN4_LINE)"
  fi
  if wait_line settled_4 "" "$SETTLE4_TIMEOUT"; then
    pass "P2.11 the post-abort run settled; P3 starts from idle"
  else
    fail "P2.11 the post-abort run did not settle within ${SETTLE4_TIMEOUT} s; P3 will run during a turn"
  fi
else
  fail "P2.10 no run 4 within ${RUN4_TIMEOUT} s after the aborted-settle delivery"
fi

# ---------------------------------------------------------------- P3

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [[ -z "$PID" ]]; then
  fail "P3.0 pi did not write $PID_FILE"
else
  say "sending SIGTERM to pi (pid $PID)"
  SIGTERM_AT=$(date +%s%3N)
  kill -TERM "$PID" 2>/dev/null || true

  if wait_line shutdown_start "" 15; then
    pass "P3.1 session_shutdown was dispatched (reason=$(str_field shutdown_start reason))"
  else
    fail "P3.1 no session_shutdown handler ran after SIGTERM"
  fi

  if wait_line shutdown_done "" "$SHUTDOWN_TIMEOUT"; then
    WAITED="$(num_field shutdown_done waited_ms)"
    if [[ -n "$WAITED" && "$WAITED" -ge $(( SHUTDOWN_SETTLE_MS - 500 )) ]]; then
      pass "P3.2 session_shutdown ran its ${SHUTDOWN_SETTLE_MS} ms async body to completion (waited_ms=${WAITED})"
    else
      fail "P3.2 shutdown_done logged waited_ms=${WAITED:-?}, less than the ${SHUTDOWN_SETTLE_MS} ms body; the timer did not run"
    fi
  else
    fail "P3.2 shutdown_done never appeared: the handler's promise was not awaited"
  fi

  EXIT_DEADLINE=$((SECONDS + SHUTDOWN_TIMEOUT))
  while (( SECONDS < EXIT_DEADLINE )); do
    [[ -f "$EXIT_FILE" ]] && break
    sleep 0.1
  done

  if [[ -f "$EXIT_FILE" ]]; then
    CODE="$(cat "$EXIT_FILE" 2>/dev/null || true)"
    EXIT_AT=$(date +%s%3N)
    ELAPSED=$((EXIT_AT - SIGTERM_AT))
    if [[ "$CODE" == "0" ]]; then
      pass "P3.3 the process exited with code 0 after ${ELAPSED} ms"
    else
      fail "P3.3 the process exited with code '$CODE' after ${ELAPSED} ms (expected 0)"
    fi
    if [[ "$ELAPSED" -le 6000 ]]; then
      pass "P3.4 SIGTERM to exit took ${ELAPSED} ms (bound 6000 ms)"
    else
      warn "SIGTERM to exit took ${ELAPSED} ms (> 6000 ms)"
    fi
  else
    fail "P3.3 no exit_code file: the process has not exited"
  fi

  if has_line process_exit ""; then
    EXIT_AFTER_DONE="$(num_field process_exit after_shutdown_done_ms)"
    EXIT_AT_MS="$(num_field process_exit at)"
    DONE_AT_MS="$(num_field shutdown_done at)"
    if [[ -n "$EXIT_AFTER_DONE" && "$EXIT_AFTER_DONE" -ge 0 \
          && -n "$EXIT_AT_MS" && -n "$DONE_AT_MS" && "$EXIT_AT_MS" -ge "$DONE_AT_MS" ]]; then
      pass "P3.2b the process exited ${EXIT_AFTER_DONE} ms after the handler completed (exit_at >= shutdown_done_at)"
    else
      fail "P3.2b process_exit is not after shutdown_done (after=${EXIT_AFTER_DONE:-missing} exit_at=${EXIT_AT_MS:-?} done_at=${DONE_AT_MS:-?})"
    fi
  else
    fail "P3.2b no process_exit line: the exit path was not observed by the probe"
  fi

  if kill -0 "$PID" 2>/dev/null; then
    fail "P3.5 the pi process is still alive"
  else
    pass "P3.5 the pi process is gone"
  fi
fi

SHUTDOWNS="$(awk 'index($0, "\"step\":\"shutdown_start\"") { c++ } END { print c + 0 }' "$PROBE_LOG" 2>/dev/null || echo 0)"
if [[ "$SHUTDOWNS" -eq 1 ]]; then
  pass "P3.6 session_shutdown was dispatched exactly once"
elif [[ "$SHUTDOWNS" -eq 0 ]]; then
  fail "P3.6 session_shutdown was never dispatched"
else
  fail "P3.6 session_shutdown was dispatched $SHUTDOWNS times in one session"
fi

# ---------------------------------------------------------------- report

say ""
say "--- pi output in the pane (tail) ---"
herdr pane read "$PANE_ID" --source recent-unwrapped --lines 40 2>/dev/null || true
say ""
say "--- probe log: $PROBE_LOG ---"
cat "$PROBE_LOG" 2>/dev/null || say "(no log)"
say ""

if [[ "$FAILED" -ne 0 ]]; then
  say "RESULT: FAIL (see the FAIL lines above; the log is kept in $OUT_DIR)"
  exit 1
fi
say "RESULT: PASS (log kept in $OUT_DIR)"
