#!/usr/bin/env bash
# bun-audit/run.sh (THE-953) -- retries `bun audit` with backoff, but ONLY on a registry-error
# output; never on a real finding. `bun audit` prints a vulnerability table and exits 1 exactly
# the same way it prints a fetch error and exits 1 -- the exit code alone cannot distinguish "the
# registry is down" from "there is a real advisory" -- so retrying is gated on the captured
# combined output ALSO matching a known registry-error marker, not on the exit code alone. A
# non-zero exit whose output carries none of those markers (a vulnerability table, or a bad
# lockfile) fails on the FIRST attempt, unretried.
#
# Configurable via env for the off-runner test (scripts/bun-audit-retry.test.mjs), which points
# BUN_AUDIT_BIN at a fake `bun` shim on PATH and sets BUN_AUDIT_BACKOFF_SECONDS to "0 0" so the
# test runs instantly:
#   BUN_AUDIT_BIN              -- the audited command (default: bun)
#   BUN_AUDIT_ATTEMPTS         -- max attempts before failing (default: 3)
#   BUN_AUDIT_BACKOFF_SECONDS  -- space-separated seconds, one entry per retry (default: 30 60 120)
set -uo pipefail

WORKING_DIR="${1:?usage: run.sh <working-directory>}"
BIN="${BUN_AUDIT_BIN:-bun}"
ATTEMPTS="${BUN_AUDIT_ATTEMPTS:-3}"
read -r -a BACKOFF <<< "${BUN_AUDIT_BACKOFF_SECONDS:-30 60 120}"

# npm's bulk advisory endpoint failing outage (THE-953): a 5xx, a timeout, a dropped connection,
# or the endpoint's own path showing up in the error text. Any ONE of these, on a non-zero exit,
# is treated as "the registry is down", never as a finding.
REGISTRY_MARKERS=(
  '503' '502' '504' 'ConnectionClosed' 'timed out' 'ETIMEDOUT' 'ECONNRESET'
  '/-/npm/v1/security/advisories/bulk'
)

is_registry_error() {
  local output="$1" marker
  for marker in "${REGISTRY_MARKERS[@]}"; do
    grep -qF "$marker" <<< "$output" && return 0
  done
  return 1
}

attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  echo "bun-audit: attempt $attempt/$ATTEMPTS ($WORKING_DIR)"
  if output=$(cd "$WORKING_DIR" && "$BIN" audit 2>&1); then
    status=0
  else
    status=$?
  fi
  echo "$output"

  if [ "$status" -eq 0 ]; then
    exit 0
  fi

  if ! is_registry_error "$output"; then
    echo "bun-audit: attempt $attempt failed with no registry-error marker in its output -- a real finding, or a bad lockfile. Not retrying."
    exit "$status"
  fi

  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    echo "::error title=npm advisory endpoint outage::bun audit could not reach registry.npmjs.org/-/npm/v1/security/advisories/bulk after $ATTEMPTS attempts (503/timeout). This is not a finding. The osv-scanner job in this workflow is the second advisory feed; read it before treating this red as a vulnerability."
    exit "$status"
  fi

  sleep_for="${BACKOFF[$((attempt - 1))]:-120}"
  echo "bun-audit: attempt $attempt looked like a registry error; retrying in ${sleep_for}s (reason: registry-error marker matched, not a finding)."
  sleep "$sleep_for"
  attempt=$((attempt + 1))
done
