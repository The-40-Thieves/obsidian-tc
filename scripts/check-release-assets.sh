#!/usr/bin/env bash
# THE-731: assert every checksummed artifact is actually attached to a release.
#
# This exists because the failure it guards was a RED job that had nonetheless shipped almost
# everything. On v1.19.0, `draft-release` exited non-zero while npm, ghcr and 10 of 11 assets were
# fine — the single casualty was the Obsidian plugin bundle, the artifact end users install. Exit
# status and actual damage pointed in opposite directions, which is exactly why it read as a flake
# across two releases instead of being diagnosed.
#
# So the check is by NAME, not by the upload step's exit code. Three independent sources, each
# covering what the others cannot:
#
#   1. SHASUMS256.txt — generated from the files that were actually built, so it names every
#      checksummed artifact without a hardcoded list. But the eight native `.node` prebuilds ship
#      through npm, not as release files, so they are never in it.
#   2. The signature manifest written by `sign-artifacts` (one `<family>\t<bundle>` line per bundle
#      it produced) — the only record that names the native bundles. Every bundle it lists must be
#      attached.
#   3. EXPECTED_FAMILIES below — the count floor. A manifest that lists nothing, or that lost a whole
#      family (signing silently produced 7 native bundles, not 8), would make (2) vacuously pass, so
#      each family's size is pinned. scripts/publish-signing.test.mjs cross-checks these numbers
#      against the build matrices in publish.yml, so adding a target without updating them fails CI.
#
# The release is looked up by numeric id because it is still a DRAFT when this runs, and
# `gh release view <tag>` does not resolve drafts.
#
# Usage: check-release-assets.sh <release-id> <path-to-SHASUMS256.txt> <path-to-signature-manifest>
# Requires: gh (authenticated), GITHUB_REPOSITORY (or GH_REPO).
set -euo pipefail

ID="${1:?usage: check-release-assets.sh <release-id> <shasums-file> <signature-manifest>}"
SUMS="${2:?usage: check-release-assets.sh <release-id> <shasums-file> <signature-manifest>}"
SIGS="${3:?usage: check-release-assets.sh <release-id> <shasums-file> <signature-manifest>}"

# family=count: 8 native prebuilds, 5 standalone binaries, 2 plugin zips, the 3 loose plugin files,
# 1 mcpb bundle.
declare -A EXPECTED_FAMILIES=(
  [native]=8
  [binary]=5
  [plugin-zip]=2
  [plugin-main]=1
  [plugin-manifest]=1
  [plugin-styles]=1
  [mcpb]=1
)

[[ "$ID" =~ ^[0-9]+$ ]] || { echo "::error::release id must be numeric, got: $ID"; exit 1; }
[ -s "$SUMS" ] || { echo "::error::$SUMS is missing or empty — nothing to verify against"; exit 1; }
[ -s "$SIGS" ] || { echo "::error::$SIGS is missing or empty — sign-artifacts produced no signature manifest"; exit 1; }

# The floor. A manifest that lists nothing would make every check below vacuously pass, which is
# the "a gate that scans zero files reports success" failure this repo has been bitten by before.
expected=$(grep -c . "$SUMS")
[ "$expected" -gt 0 ] || { echo "::error::$SUMS lists 0 artifacts"; exit 1; }

repo="${GH_REPO:-${GITHUB_REPOSITORY:?GITHUB_REPOSITORY or GH_REPO must be set}}"
attached=$(gh api --paginate "repos/$repo/releases/$ID/assets" --jq '.[].name' | sort -u)
[ -n "$attached" ] || { echo "::error::release $ID has no assets attached"; exit 1; }

problems=0
fail() { echo "::error::$1"; problems=$((problems + 1)); }

# --- signature manifest: shape, per-family counts, every listed bundle attached ------------------
declare -A seen_family=()
declare -A listed=()
total=0
while IFS=$'\t' read -r family bundle extra; do
  [ -n "${family:-}" ] || continue
  if [ -z "${bundle:-}" ] || [ -n "${extra:-}" ] || [[ "$bundle" != *.sigstore.json ]]; then
    fail "malformed signature-manifest line: '$family' '${bundle:-}'"
    continue
  fi
  if [ -z "${EXPECTED_FAMILIES[$family]:-}" ]; then
    fail "signature manifest lists unknown family '$family' (bundle $bundle)"
    continue
  fi
  if [ -n "${listed[$bundle]:-}" ]; then
    fail "signature manifest lists $bundle twice"
    continue
  fi
  listed[$bundle]=1
  seen_family[$family]=$(( ${seen_family[$family]:-0} + 1 ))
  total=$((total + 1))
  grep -qxF "$bundle" <<<"$attached" || fail "release $ID is missing the cosign bundle: $bundle"
done < "$SIGS"

want_total=0
for family in "${!EXPECTED_FAMILIES[@]}"; do
  want=${EXPECTED_FAMILIES[$family]}
  want_total=$((want_total + want))
  got=${seen_family[$family]:-0}
  [ "$got" -eq "$want" ] || fail "signature manifest has $got '$family' bundle(s), expected $want"
done
[ "$total" -eq "$want_total" ] || fail "signature manifest lists $total bundle(s), expected $want_total"

# --- checksummed artifacts: attached, and their bundle both listed and attached ------------------
while read -r _sum path; do
  [ -n "${path:-}" ] || continue
  name=$(basename "$path")
  grep -qxF "$name" <<<"$attached" || fail "release $ID is missing checksummed asset: $name"
  [ -n "${listed[$name.sigstore.json]:-}" ] || fail "signature manifest has no bundle for checksummed asset: $name"
  grep -qxF "$name.sigstore.json" <<<"$attached" || fail "release $ID is missing the cosign bundle: $name.sigstore.json"
done < "$SUMS"

# The three loose plugin files are attached but not checksummed.
for name in main.js manifest.json styles.css; do
  grep -qxF "$name" <<<"$attached" || fail "release $ID is missing plugin asset: $name"
done

if [ "$problems" -gt 0 ]; then
  echo "::error::$problems problem(s) with release $ID ($expected checksummed artifact(s), $want_total cosign bundle(s) expected)"
  exit 1
fi

echo "release $ID: all $expected checksummed artifacts and all $want_total cosign bundles attached"
