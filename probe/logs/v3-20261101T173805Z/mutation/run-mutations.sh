#!/usr/bin/env bash
# Mutation sweep for the 0.5.0 delivery/roster/schedule behaviour.
#
# Each mutation: fresh copy of the repo (node_modules symlinked), apply one src-only
# change with python, run the named test files, record which test names failed.
# The test tree is never touched. A mutation that leaves every test green is a hole.
set -u
REPO=/home/yang/Documents/pigroups-adapter
OUT="$(cd "$(dirname "$0")" && pwd)"
SCRATCH=$(mktemp -d /tmp/v3mut.XXXXXX)
trap 'rm -rf "$SCRATCH"' EXIT

copy_repo() {
  local dest=$1
  mkdir -p "$dest"
  (cd "$REPO" && tar -c --exclude=node_modules --exclude=.git .) | (cd "$dest" && tar -x)
  ln -s "$REPO/node_modules" "$dest/node_modules"
}

# run_one <name> <tests> <python-patch-file>
run_one() {
  local name=$1 tests=$2 patch=$3
  local dir="$SCRATCH/$name"
  copy_repo "$dir"
  python3 "$patch" "$dir" || { echo "$name PATCH-FAILED"; return 1; }
  ( cd "$dir" && PIGROUPS_PLATFORM_DIR=/home/yang/Documents/PiGroups timeout 300 node --test $tests > "$OUT/$name.log" 2>&1 )
  local rc=$?
  local failed
  failed=$(grep -E '^✖ ' "$OUT/$name.log" | grep -v 'failing tests:' | sed 's/^✖ //' | sed 's/ ([0-9.]*ms)$//' | sort -u)
  local passed
  passed=$(grep -cE '^✔ ' "$OUT/$name.log")
  echo "### $name (exit $rc, passed $passed)"
  if [ -z "$failed" ]; then
    echo "NO FAILING TEST — MUTATION SURVIVED"
  else
    echo "$failed" | sed 's/^/  RED: /'
  fi
  echo
}

run_one window-trigger test/delivery.test.ts "$OUT/patch-window.py"
run_one no-busy-gate test/delivery.test.ts "$OUT/patch-busy.py"
run_one steer-delivery test/surface.test.ts "$OUT/patch-steer.py"
run_one abort-closes-window test/control.test.ts "$OUT/patch-abort.py"
run_one requeue-on-abort test/delivery.test.ts "$OUT/patch-requeue.py"
run_one members-relation test/members.test.ts "$OUT/patch-relation.py"
run_one schedule-lower-bound test/schedule.test.ts "$OUT/patch-schedule-lower.py"
run_one schedule-upper-bound test/schedule.test.ts "$OUT/patch-schedule-upper.py"
run_one schedule-limit test/schedule.test.ts "$OUT/patch-schedule-limit.py"
run_one schedule-window test/schedule.test.ts "$OUT/patch-schedule-window.py"
run_one members-query-case test/members.test.ts "$OUT/patch-member-query.py"
run_one last-assistant-text test/surface.test.ts "$OUT/patch-last-text.py"
