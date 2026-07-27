#!/usr/bin/env bash
# Run a heavy command under a host CPU budget: one at a time, and capped.
#
#   scripts/with-host-budget.sh <command> [args...]
#
# Two independent mechanisms, because they fail differently:
#
#   1. An exclusive flock. Vitest's maxWorkers bounds ONE process; it cannot stop two agents each
#      starting a capped run. Only a lock outside every process can. This is the piece that was
#      missing when three concurrent agents drove a 4-core host to load 28.
#
#   2. A systemd scope with CPUQuota, when available. The lock assumes every heavy command comes
#      through here; the cgroup does not care what the command believes about its own concurrency,
#      so it still holds if a tool ignores its worker setting or spawns something unexpected.
#
# No-ops gracefully everywhere the mechanism is absent (macOS, containers, CI) — this must never be
# the reason a command fails to run.

set -euo pipefail

[ $# -gt 0 ] || { echo "usage: $0 <command> [args...]" >&2; exit 2; }

# CI runners are dedicated. Serialising or throttling there buys nothing and slows every PR.
if [ -n "${CI:-}" ]; then exec "$@"; fi

LOCK="${OBSIDIAN_TC_HOST_LOCK:-${TMPDIR:-/tmp}/obsidian-tc-host-budget.lock}"

# Leave at least one core for the services this host is also running (containers, Falco, the
# remote desktop the maintainer is connected over). 250% = 2.5 of 4 cores.
QUOTA="${OBSIDIAN_TC_CPU_QUOTA:-250%}"

run_capped() {
  # --user --scope needs a user systemd instance; absent under sudo, in containers, and on macOS.
  if command -v systemd-run >/dev/null 2>&1 &&
     systemd-run --user --scope -q -p CPUQuota=1% -- true >/dev/null 2>&1; then
    exec systemd-run --user --scope -q -p "CPUQuota=$QUOTA" -- "$@"
  fi
  exec "$@"
}

if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK" || run_capped "$@"
  if ! flock -n 9; then
    echo "[host-budget] another heavy run holds $LOCK — waiting rather than oversubscribing." >&2
    flock 9
  fi
  run_capped "$@"
fi

# No flock (macOS without util-linux): still cap, just cannot serialise.
run_capped "$@"
