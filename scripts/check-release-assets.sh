#!/usr/bin/env bash
# THE-731: assert every checksummed artifact is actually attached to a release.
#
# This exists because the failure it guards was a RED job that had nonetheless shipped almost
# everything. On v1.19.0, `draft-release` exited non-zero while npm, ghcr and 10 of 11 assets were
# fine — the single casualty was the Obsidian plugin bundle, the artifact end users install. Exit
# status and actual damage pointed in opposite directions, which is exactly why it read as a flake
# across two releases instead of being diagnosed.
#
# So the check is by NAME against SHASUMS256.txt, not by the upload step's exit code and not by a
# hardcoded count. A hardcoded count would need editing every time the asset set changes and would
# silently pass if one artifact were swapped for another; the manifest is generated from the files
# that were actually built, so it is the honest source of truth for what must be present.
#
# Usage: check-release-assets.sh <tag> <path-to-SHASUMS256.txt>
# Requires: gh (authenticated), jq-free (uses gh --jq).
set -euo pipefail

TAG="${1:?usage: check-release-assets.sh <tag> <shasums-file>}"
SUMS="${2:?usage: check-release-assets.sh <tag> <shasums-file>}"

[ -s "$SUMS" ] || { echo "::error::$SUMS is missing or empty — nothing to verify against"; exit 1; }

# The floor. A manifest that lists nothing would make every check below vacuously pass, which is
# the "a gate that scans zero files reports success" failure this repo has been bitten by before.
expected=$(grep -c . "$SUMS")
[ "$expected" -gt 0 ] || { echo "::error::$SUMS lists 0 artifacts"; exit 1; }

attached=$(gh release view "$TAG" --json assets --jq '.assets[].name' | sort -u)

missing=0
while read -r _sum path; do
  [ -n "${path:-}" ] || continue
  name=$(basename "$path")
  if ! grep -qxF "$name" <<<"$attached"; then
    echo "::error::release $TAG is missing checksummed asset: $name"
    missing=$((missing + 1))
  fi
done < "$SUMS"

if [ "$missing" -gt 0 ]; then
  echo "::error::$missing of $expected checksummed artifact(s) missing from $TAG"
  exit 1
fi

echo "release $TAG: all $expected checksummed artifacts attached"
