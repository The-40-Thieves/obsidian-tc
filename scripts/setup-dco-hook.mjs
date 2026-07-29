#!/usr/bin/env node
/**
 * Bootstrap for a local DCO sign-off hook. Every non-merge commit needs a `Signed-off-by:`
 * trailer (`git commit -s`; see CONTRIBUTING.md's "License and Sign-off (DCO)" section) and the
 * `dco` CI check enforces it on every PR — but until now the only feedback for forgetting `-s`
 * was a red check after a push. This installs a `prepare-commit-msg` hook that appends the
 * trailer automatically, the same way `-s` would, so a missing sign-off is caught locally.
 *
 * NOT wired through prek/.pre-commit-config.yaml: every hook there is `repo: local`
 * deliberately (see that file's header), and prek only manages the `pre-commit` stage unless a
 * contributor separately runs `prek install --hook-type prepare-commit-msg` — one more manual
 * step nobody would remember to run. Wired instead as a sibling of
 * scripts/setup-git-merge-driver.mjs, off the SAME root package.json `prepare` script that
 * already runs on every `bun install` — no new step for contributors to remember.
 *
 * Installs into the git COMMON dir (`git rev-parse --git-common-dir`), not the per-worktree
 * admin dir `--git-dir` would report inside a linked worktree — hooks/ is shared across all
 * worktrees of a repo, so a worktree-local install would silently do nothing for commits made
 * from the main checkout (or any other worktree).
 *
 * Idempotent and non-destructive: refuses to overwrite a prepare-commit-msg hook it did not
 * write — a contributor's own hook is left alone, reported instead of clobbered.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARKER = "# obsidian-tc: DCO sign-off (scripts/setup-dco-hook.mjs)";

const HOOK_BODY = `#!/bin/sh
${MARKER}
# Appends a Signed-off-by trailer to every commit message, equivalent to \`git commit -s\` — so a
# contributor who forgot -s still produces a DCO-compliant commit. See CONTRIBUTING.md's
# "License and Sign-off (DCO)" section; the \`dco\` CI check verifies the same trailer shape
# (^Signed-off-by: .+ <.+@.+>$).
COMMIT_MSG_FILE="$1"
NAME=$(git config user.name)
EMAIL=$(git config user.email)
if [ -z "$NAME" ] || [ -z "$EMAIL" ]; then
  exit 0
fi
SOB="Signed-off-by: $NAME <$EMAIL>"
if ! grep -qsF "$SOB" "$COMMIT_MSG_FILE"; then
  printf '\\n%s\\n' "$SOB" >> "$COMMIT_MSG_FILE"
fi
`;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

let gitCommonDir;
try {
  gitCommonDir = git(["rev-parse", "--git-common-dir"]);
} catch {
  console.log("setup-dco-hook: not inside a git working tree — skipping (nothing to configure).");
  process.exit(0);
}

const hooksDir = join(gitCommonDir, "hooks");
mkdirSync(hooksDir, { recursive: true });
const hookPath = join(hooksDir, "prepare-commit-msg");

if (existsSync(hookPath)) {
  const existing = readFileSync(hookPath, "utf8");
  if (!existing.includes(MARKER)) {
    console.log(
      `setup-dco-hook: ${hookPath} already exists and was not written by this script — leaving ` +
        "it alone. Add the Signed-off-by trailer yourself (`git commit -s`) or fold this hook's " +
        "body into your own.",
    );
    process.exit(0);
  }
}

writeFileSync(hookPath, HOOK_BODY);
chmodSync(hookPath, 0o755);
console.log(`setup-dco-hook: installed ${hookPath} (auto-signs off every commit).`);
