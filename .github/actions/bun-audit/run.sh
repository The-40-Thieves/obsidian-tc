#!/usr/bin/env bash
# bun-audit/run.sh (THE-953) -- retries `bun audit` with backoff, but ONLY on a registry-error
# output; never on a real finding. `bun audit` prints a vulnerability table and exits 1 exactly
# the same way it prints a fetch error and exits 1 -- the exit code alone cannot distinguish "the
# registry is down" from "there is a real advisory" -- so retrying is gated on the captured
# combined output ALSO matching a known registry-error shape, not on the exit code alone. A
# non-zero exit whose output carries no such shape (a vulnerability table, or a bad lockfile)
# fails on the FIRST attempt, unretried.
#
# Fix round 1 (adversarial review, HIGH finding): the first version matched bare substrings
# ('503', '502', '504', ...) anywhere in the combined output. A real advisory whose vulnerable
# version range, CVE id, or advisory number happens to contain "503" (e.g. aws-sdk's
# <2.1504.0 range, or CVE-2023-45032) was misclassified as a registry outage -- burning three
# retries and then printing "This is not a finding" over an actual finding. The classification is
# now line-scoped and shape-scoped instead of a substring sweep over the whole report:
#
#   (a) only a line that STARTS WITH "error:" (bun's own error-line shape, e.g.
#       "error: POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - 503") is even
#       considered. A finding is rendered as a table/summary, never as an "error:"-prefixed line,
#       so no advisory text can trip this by construction. On such a line, a match requires EITHER
#       the endpoint path itself (a bare 5xx digit run only ever means something when it trails
#       that path on this exact line shape -- there is no separate digit-only check) OR one of the
#       named transport keywords.
#   (b) belt and suspenders: if the output carries a findings summary line ("N vulnerability" /
#       "N vulnerabilities" / "No vulnerabilities found"), it is NEVER treated as a registry error
#       regardless of (a) -- a real `bun audit` run never emits both shapes at once, so this only
#       ever fires as a second, independent guard against a misclassification.
#
# Configurable via env for the off-runner test (scripts/bun-audit-retry.test.mjs), which points
# BUN_AUDIT_BIN at a fake `bun` shim on PATH and sets BUN_AUDIT_BACKOFF_SECONDS to "0 0" so the
# test runs instantly:
#   BUN_AUDIT_BIN              -- the audited command (default: bun)
#   BUN_AUDIT_ATTEMPTS         -- max attempts before failing (default: 3)
#   BUN_AUDIT_BACKOFF_SECONDS  -- space-separated seconds, one entry per retry (default: 30 60)
set -uo pipefail

WORKING_DIR="${1:?usage: run.sh <working-directory>}"
BIN="${BUN_AUDIT_BIN:-bun}"
ATTEMPTS="${BUN_AUDIT_ATTEMPTS:-3}"
read -r -a BACKOFF <<< "${BUN_AUDIT_BACKOFF_SECONDS:-30 60}"

# Fix round 1 (MEDIUM finding): ATTEMPTS < 1 (or non-numeric) previously fell through the while
# loop silently -- the step exited 0 having never invoked `bun audit`, which is this repo's own
# "a gate that scans zero files reports success" failure shape. Fail loudly and name the bad
# input instead.
if ! [[ "$ATTEMPTS" =~ ^[0-9]+$ ]] || [ "$ATTEMPTS" -lt 1 ]; then
  echo "::error title=bun-audit misconfigured::BUN_AUDIT_ATTEMPTS (\"$ATTEMPTS\") must be a positive integer -- a value below 1 would skip the audit entirely and still exit 0."
  exit 2
fi

# Transport-failure keywords that, on an "error:"-prefixed line, mean the registry itself is
# unreachable rather than that it returned a real result.
TRANSPORT_MARKERS=('ConnectionClosed' 'ETIMEDOUT' 'ECONNRESET' 'timed out' 'fetch failed')
ENDPOINT_PATH='/-/npm/v1/security/advisories/bulk'

# A real finding is always summarised this way ("1 vulnerability (1 high)", "3 vulnerabilities",
# or "No vulnerabilities found" on success) -- never as an "error:"-prefixed line. Treated as an
# unconditional override: this output is a real result, full stop, regardless of what else it
# contains.
has_findings_summary() {
  grep -qE '[0-9]+ vulnerabilit(y|ies)' <<< "$1" && return 0
  grep -qF 'No vulnerabilities found' <<< "$1" && return 0
  return 1
}

is_registry_error() {
  local output="$1" line marker
  has_findings_summary "$output" && return 1
  while IFS= read -r line; do
    case "$line" in
      error:*)
        [[ "$line" == *"$ENDPOINT_PATH"* ]] && return 0
        for marker in "${TRANSPORT_MARKERS[@]}"; do
          [[ "$line" == *"$marker"* ]] && return 0
        done
        ;;
    esac
  done <<< "$output"
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
    echo "bun-audit: attempt $attempt failed with no registry-error shape in its output -- a real finding, or a bad lockfile. Not retrying."
    exit "$status"
  fi

  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    echo "::error title=npm advisory endpoint outage::bun audit could not reach registry.npmjs.org/-/npm/v1/security/advisories/bulk after $ATTEMPTS attempts (503/timeout). This is not a finding. The osv-scanner job in this workflow is the second advisory feed; read it before treating this red as a vulnerability."
    exit "$status"
  fi

  sleep_for="${BACKOFF[$((attempt - 1))]:-60}"
  echo "bun-audit: attempt $attempt looked like a registry error; retrying in ${sleep_for}s (reason: registry-error shape matched, not a finding)."
  sleep "$sleep_for"
  attempt=$((attempt + 1))
done
