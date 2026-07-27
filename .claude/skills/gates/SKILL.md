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

## Offload the full suite — don't run it locally

This repo is developed on a 4-core host that also runs ~43 containers, Falco and a remote desktop.
A local full-suite run costs the whole box; two at once have driven it to load 28, and THE-503
measured an overlapping run reading throughput **51% low** while the gate still passed.

Standard GitHub-hosted runners are **free and unmetered for public repositories**, and this repo is
public. The suite that already runs on every PR can be triggered directly:

```bash
gh workflow run ci-server.yml --ref <branch>
gh run watch $(gh run list -w ci-server.yml -L1 --json databaseId --jq '.[0].databaseId')
```

That runs `lint`, `build-test` on ubuntu/windows/macos, and `bun-smoke` on dedicated hardware —
and catches the platform-specific failures a Linux-only local run cannot (a `chmod 000` test passed
on ubuntu and macos and failed only on windows, because Windows has no POSIX mode bits).

`perf` deliberately does **not** run on dispatch — it is gated on `github.event_name == 'push'`
because it lives in the non-ref-scoped `perf-exclusive` group, and ad-hoc runs would cancel main's
pending perf jobs.

**Keep targeted vitest local.** A single test file is faster than a round trip and saturates
nothing. What must run locally should go through `scripts/with-host-budget.sh` (or
`bun run test:local`), which serialises via flock and caps at 2.5 cores.

## Never pipe a gate through `tail` or `head`

```bash
bun run lint 2>&1 | tail -20      # WRONG — $? is the pipe's status
bun run lint > /tmp/lint.log 2>&1; echo "exit=$?"   # right
```

A pipeline reports the *pipe's* exit code. This has masked both a failing suite and a failing lint
in this repo. Redirect to a uniquely-named log and check `$?` separately.

## Required status checks

Don't trust a number written here — the set changes. Read it:

```bash
gh api repos/The-40-Thieves/obsidian-tc/branches/main/protection/required_status_checks \
  --jq '.contexts[]' | sort
```

All four `build-test` legs are required, **including `ubuntu-24.04-arm`** — the repo ships an
aarch64 binary and production runs Ampere, and `vec.ts` documents a measured retrieval divergence
between aarch64 and x86_64 (nDCG@10 0.8028 vs 0.8414 on the same commit).

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
