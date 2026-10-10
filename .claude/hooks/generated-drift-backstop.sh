#!/bin/bash
# PostToolUse/Bash backstop: tell the model when a Bash call left a wholly generated artifact
# modified without running that artifact's generator.
#
# block-generated-edits.sh and the `permissions.deny` rules cover the Edit/Write tools. A shell can
# still write a protected file in ways no pre-parser sees: a computed path, a shell variable, a
# script file, `git apply`/`patch`, a heredoc'd Python program. This hook does not try to parse the
# command; it looks at the RESULT, which is what matters. The CI drift gate stays the final net.
#
# The protected paths and their generators come from .claude/generated-paths.txt (the single source
# of truth; format `<path>\t<regenerate command>`).
#
# One `git diff HEAD` over the protected paths (staged hand edits count) plus one `rev-parse`.
#
# Not nagging: a file that was already modified BEFORE this command (a legitimate regeneration that
# leaves a diff, or an edit already reported) must not be reported again on every later Bash call.
# So the checksum of the protected-paths diff is kept per session in the git dir, and the hook only
# speaks when that checksum has CHANGED since the last Bash call, i.e. this command changed it.
# That needs no command parsing, so the heredoc/script bypasses are covered; a clean diff deletes
# the marker so the next hand edit is reported again. If two protected files are dirty at once, a
# change to either re-reports both: rare, and still correct.
#
# Excused (silent): the command names the file's own regenerate command, or is a history-moving
# command (merge, rebase, pull, cherry-pick, revert, stash) or `bun install`. Those are where
# scripts/merge-drivers/regen.mjs (.gitattributes `merge=regen`) legitimately rewrites
# migrations-embedded.ts, and the result differs from HEAD until committed.
#
# Advisory and fail-open: always exit 0, any error stays silent.

INPUT=$(cat)
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || exit 0
[ -n "$CWD" ] || exit 0
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // "nosession"' 2>/dev/null)

{
  read -r ROOT
  read -r GITDIR
} < <(git -C "$CWD" rev-parse --show-toplevel --absolute-git-dir 2>/dev/null)
[ -n "$ROOT" ] && [ -n "$GITDIR" ] || exit 0

LIST="$ROOT/.claude/generated-paths.txt"
[ -r "$LIST" ] || exit 0
PATHS=()
GENS=()
while IFS=$'\t' read -r P G || [ -n "$P" ]; do
  case "$P" in "" | "#"*) continue ;; esac
  PATHS+=("$P")
  GENS+=("$G")
done <"$LIST"
[ "${#PATHS[@]}" -gt 0 ] || exit 0

MARKER="$GITDIR/claude-generated-drift"
DIFF=$(git -C "$ROOT" diff HEAD --no-ext-diff --no-color -- "${PATHS[@]}" 2>/dev/null) || exit 0
if [ -z "$DIFF" ]; then
  rm -f "$MARKER"
  exit 0
fi

STATE="$SID $(printf '%s' "$DIFF" | cksum)"
SEEN=$(cat "$MARKER" 2>/dev/null)
printf '%s\n' "$STATE" >"$MARKER" 2>/dev/null
[ "$STATE" = "$SEEN" ] && exit 0

HISTORY_RE='(^|[^[:alnum:]_-])(git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?(merge|rebase|pull|cherry-pick|revert|stash)([^[:alnum:]_-]|$)|bun[[:space:]]+install([^[:alnum:]_-]|$))'
if [[ $CMD =~ $HISTORY_RE ]]; then
  exit 0
fi

MSG=""
for i in "${!PATHS[@]}"; do
  P=${PATHS[$i]}
  G=${GENS[$i]}
  printf '%s\n' "$DIFF" | grep -qxF "diff --git a/$P b/$P" || continue
  [ -n "$G" ] && [[ $CMD == *"$G"* ]] && continue
  # shellcheck disable=SC2016 # the backticks are literal markdown for the model
  MSG+="[obsidian-tc] $P changed outside its generator: \`git checkout -- $P\`, then run \`${G:-its generator}\`."$'\n'
done
[ -n "$MSG" ] || exit 0

jq -n --arg m "$MSG" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $m}}'
exit 0
