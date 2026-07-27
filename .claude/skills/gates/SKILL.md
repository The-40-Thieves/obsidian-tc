---
name: gates
description: Run this repo's verification gates before opening a PR — enumerates them from the CI workflows rather than from memory, because several have confusingly adjacent names.
---

# gates

**Enumerate from `.github/workflows/`, never from recall.** This repo has 9 bespoke `check:*`
scripts, 5 `docgen:*` scripts, and 3 generator `--check` scripts across 18 workflows. Two pairs have
names close enough to substitute for each other by mistake:

| looks like the same thing | is not |
|---|---|
| `check:config-paths` | sweeps prose for config keys that no longer resolve |
| `config:schema:check` | regenerates and diffs `docs/obsidian-tc.config.schema.json` |

Running the first and believing it covered the second cost a full CI round on PR #513. That is the
reason this skill exists.

## Get the authoritative list

```bash
# every gate CI actually runs, from the workflows themselves
rg -n 'run: (bun|node|npx)' .github/workflows/*.yml
```

`drift-gate` alone is **five** steps (`ci-docgen.yml`) — read them, don't assume.

## The usual pre-PR set

```bash
bun run lint                       # biome + every check:* gate
bun run typecheck                  # all 4 workspaces
cd packages/server && node ./node_modules/vitest/vitest.mjs run

bun run check:version
bun run map:check                  # TREE.md + docs/dependency-graph.json
bun run config:schema:check        # NOT check:config-paths
bun run migrations:embed:check
cd packages/server && bun run docgen:render -- --check
cd packages/server && bun run docgen:facts-check
```

## Never pipe a gate through `tail` or `head`

```bash
bun run lint 2>&1 | tail -20      # WRONG — $? is the pipe's status
bun run lint > /tmp/lint.log 2>&1; echo "exit=$?"   # right
```

A pipeline reports the *pipe's* exit code. This has masked both a failing suite and a failing lint
in this repo. Redirect to a uniquely-named log and check `$?` separately.

## Required status checks (25 on `main`)

Green locally is not the merge floor. Gate a merge on:

1. every **required** check PRESENT — a path-filtered-away required check reads as clean but never ran
2. zero in flight
3. **no `CANCELLED` or `TIMED_OUT` anywhere**, required or not

`CANCELLED` is a *completed* conclusion, so "no failures and nothing pending" lets it through. The
`perf` job sits in a non-ref-scoped `perf-exclusive` concurrency group and loses its run whenever
PRs overlap.

`perf` is deliberately **not** required — it is `push`-only and requiring it would deadlock every PR.

If `gh pr merge` reports `BLOCKED` with every real signal green, that is a stale cached verdict
(cli/cli#13388). Merge via the REST API — **not** `--admin`:

```bash
SHA=$(gh pr view <N> --json headRefOid --jq .headRefOid)
gh api -X PUT repos/The-40-Thieves/obsidian-tc/pulls/<N>/merge \
  -f merge_method=squash -f sha="$SHA"
```

Passing `sha` matters: it refuses if the head moved since you checked. "Green" is a property of a
*commit*, not of a PR.

## Adding a gate

A gate that has never failed proves nothing. Before trusting a new one:

1. **Assert a non-empty floor first** — `expect(files.length).toBeGreaterThan(N)`. Without it a
   broken directory walk makes every later assertion pass vacuously.
2. **Watch it fail.** Mutate the thing it guards, confirm red, revert, confirm green. Verify the
   mutation actually applied — a no-op mutation that "passes" is the exact trap.
3. **Normalize path separators** — `abs.slice(root.length + 1).split(sep).join("/")`, or it passes
   on Linux and fails only on `build-test (windows-latest)`.
4. **Prefer a compile-time gate.** `Record<K, V>` (not `Partial`) makes an omission fail to compile,
   which strictly dominates a runtime scan.
