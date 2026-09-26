# alexandria-tc Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn obsidian-tc and alexandria-mcp into one MIT monorepo named alexandria-tc with a corpus contract around the Obsidian vault, Alexandria imported with history as a corpus package, both runtimes green in CI, and a `2.0.0` cut under the new names with deprecation shims for the old ones, changing no user-visible behaviour.

**Architecture:** Rename the obsidian-tc repo (keeps OIDC bindings, redirects, history), lift `db/ search/ embeddings/ graph/` into `packages/core`, add `packages/corpus` (contract, `FileCorpus`, conformance kit) and `packages/corpus-obsidian` (the vault as a corpus), import Alexandria via `git filter-repo` into `packages/corpus-library`. The server keeps calling the same functions through one-line re-export files, so the 161-tool catalog stays byte-identical; a new catalog-diff gate proves it on every PR.

**Tech Stack:** Bun 1.4.2 (primary; workspaces, `bun run --filter`), Node 26.5.0 (vitest for the server, `node --test` for corpus-library), TypeScript, zod, sqlite via the existing driver seam, dependency-cruiser (boundary gate), git-filter-repo, GitHub Actions with npm OIDC trusted publishing.

**Spec:** `docs/superpowers/specs/2026-09-26-alexandria-tc-foundation-design.md`

**Inputs after approval:** the 2026-09-26 platform survey (spec Appendix A) changed no task here; its findings land in the hosted-deploy and authorization-server children of the remote-first epic and in sub-projects 2 and 3.

## Global Constraints

- Toolchain pins from `mise.toml`: `bun = "1.4.2"`, `node = "26.5.0"`. Run repo commands via `mise exec --` or an activated mise shell.
- Node floor: dev runs Node 26.5.0 but CI validates the **Node 24** floor (`engines.node: ">=24"`, `@types/node ^24`). New packages copy that `engines` and `@types/node` pin; never type against a 26-only API.
- Full suites run on GitHub runners, not on Cave (4 cores shared with ~43 containers): `gh workflow run ci-server.yml --ref <branch>` and `gh workflow run ci-corpus.yml --ref <branch>`; local runs are targeted vitest (`bunx vitest run <path>`) or `bun run test:local` in `packages/server`. Every "Run: just test" line in this plan means "dispatch ci-server.yml and read the run" unless a single package is named.
- `bun run map` runs AFTER `git add` and is the LAST thing before commit (it counts tracked files); then `bun run map:check`. Never hand-edit `TREE.md`, `docs/dependency-graph.json`, the config schema JSON or `migrations-embedded.ts` (a PreToolUse hook blocks it).
- The tool count's source of truth is `REGISTERED_TOOL_COUNT` in `packages/server/test/registered-tool-count.ts` (read by `check-version-coherence.mjs`); the catalog gate's floor and BASELINE.md cite it, not a grep.
- License: **MIT** in the root `LICENSE` and in every `packages/*/package.json` `license` field. No AGPL text remains outside `CHANGELOG.md` and `docs/adr/`.
- Names: server npm package `@the-40-thieves/alexandria-tc`, bin `alexandria-tc`, `mcpName` and `server.json` name `io.github.The-40-Thieves/alexandria-tc`, image `ghcr.io/the-40-thieves/alexandria-tc`. Internal packages `@the-40-thieves/alexandria-tc-<name>`. Published version lockstep `2.0.0`.
- Runtime rule: `bun:` imports allowed only in `packages/core/src/db/bun-sqlite.ts` and under `packages/native/`. Enforced by a dependency-cruiser rule (Task 12).
- Public text rule: no `THE-<digits>` or `linear.app` in README, docs site, package READMEs or MCP manifests (`bun run check:public-text` is the gate). This plan and the spec live under `docs/superpowers/`, which that gate does not scan; keep ticket ids out of user-facing files anyway.
- Git: every commit signed off (`git commit --signoff`, the DCO check enforces it). Never `git add -A`; add named paths. One PR per spec step (six PRs), each merged only green. Regenerate `TREE.md` with `just map` whenever files move; `just map-check` is a CI gate.
- Tests: `just test` is the CI-equivalent run (`bun run --filter='!obsidian-tc' test` then vitest under Node in `packages/server`); `just test-bun` is the fast local loop and is NOT a CI-equivalent result.
- Existence floors: every new gate asserts a minimum count (tools ≥ 150, server tests ≥ the count recorded in Task 0, sources ≥ 150) so an empty run cannot pass.
- Zero behaviour change until Task 14: no tool added, removed, renamed or re-described; config schema untouched (`bun run config:schema:check`); DB migration manifest untouched.

## Review Focus

1. **Hard-link and symlink guards after the move** (Task 7). `notes-io.ts` refuses a note whose inode has `nlink > 1` and opens write temps with `O_NOFOLLOW`; a person with a vault containing a planted hard link expects the same refusal after the file moves packages. Pinned by keeping `packages/server/src/vault/notes-io.test.ts`'s cases running from their new location and adding a `FileCorpus.read` test on a hard-linked fixture.
2. **Stale-version write** (Task 8). A person whose note changed in Obsidian between an agent's read and write expects the write refused, not overwritten. Pinned by the conformance kit's compare-and-swap case run against `ObsidianCorpus`.
3. **Windows locators** (Task 7). A vault path with backslashes or a drive letter must produce the same `locator` the ACL rules were written against. Pinned by a `toLocator` test with `C:\\vault\\a\\b.md` and `a/b.md` inputs.
4. **Alexandria under Bun without the SQLite HTTP cache** (Task 10). When `undici.cacheStores` is absent, fetches must still go through the pinned-connection dispatcher (`urlGuard`), not a bare global fetch. Pinned by a test that imports the dispatcher with `cacheStores` stubbed to `undefined` and asserts `setGlobalDispatcher` was still called with an `Agent`.
5. **Shim with the new package missing** (Task 15). A person who installs `obsidian-tc@1.32.0` offline expects one clear line naming the new package, not a stack trace. Pinned by a shim test that runs the bin with `NODE_PATH` emptied and asserts the exit code and message.

---

## File Structure

Created:
- `scripts/catalog-snapshot.mjs` — starts the server on stdio, records `tools/list` + `resources/list` as canonical JSON; `--check` diffs against `docs/catalog/tools.snapshot.json`.
- `scripts/catalog-snapshot.test.mjs` — canonicalisation and floor tests.
- `scripts/check-license-coherence.mjs` (+ `.test.mjs`) — every package `license` is `MIT`, root LICENSE is MIT text.
- `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts` — lifted `db/ search/ embeddings/ graph/`.
- `packages/corpus/package.json`, `tsconfig.json`, `src/types.ts` (contract), `src/capabilities.ts`, `src/registry.ts`, `src/locator.ts`, `src/file/file-corpus.ts` (+ moved `notes-io.ts`, `paths.ts`, `watcher.ts` under `src/file/`), `src/conformance/kit.ts`, `src/conformance/memory-corpus.ts`, tests beside each.
- `packages/corpus-obsidian/package.json`, `tsconfig.json`, `src/index.ts`, `src/obsidian-corpus.ts` (+ moved `frontmatter.ts`, `links.ts`, `tags.ts`, `registry.ts`, `persist-note.ts`, `formats/`), tests beside each.
- `packages/server/src/vault/{notes-io,paths,watcher,frontmatter,links,tags,registry,persist-note}.ts` — become one-line re-exports.
- `scripts/import-alexandria.sh`, `scripts/check-import-history.mjs` (+ test).
- `packages/corpus-library/` — Alexandria's tree after filter-repo; `package.json` renamed; `src/utils/dispatcher.ts` ported.
- `packages/shim-obsidian-tc/{package.json,bin.mjs,bin.test.mjs}`, `packages/shim-alexandria-mcp/{package.json,bin.mjs,bin.test.mjs}`.
- `.github/workflows/ci-corpus.yml` — Node + Bun jobs for the three corpus packages; catalog and license gates wired into `ci-server.yml` / `ci-version.yml`.

Modified:
- root `package.json` (workspaces, catalog, scripts), `LICENSE`, `README.md`, `SECURITY.md`, `.dependency-cruiser.cjs`, `justfile`, `TREE.md` (regenerated), `packages/server/package.json`, `server.json`, `.github/workflows/{ci-server,ci-version,publish,release-image}.yml`, `scripts/{release,check-version-coherence,check-mcp-name,check-facade-parity}.mjs` where they name paths or names.

---

### Task 0: Record the baseline the invariants compare against

**Files:**
- Create: `docs/catalog/BASELINE.md`

**Interfaces:**
- Produces: the numbers every later task's existence floor uses.

- [ ] **Step 1: Confirm the branch and clean tree**

Run: `cd ~/src/obsidian-tc && git switch -c foundation/00-baseline main && git status -sb`
Expected: `## foundation/00-baseline` and no changes.

- [ ] **Step 2: Count server tests, tools, and sources**

Run:
```bash
cd packages/server && node ./node_modules/vitest/vitest.mjs run 2>&1 | tail -3
cd ../.. && rg -n 'export const REGISTERED_TOOL_COUNT' packages/server/test/registered-tool-count.ts
cd ~/alexandria-mcp && ALEXANDRIA_STATE_DB=:memory: NODE_ENV=test node --test 'src/**/*.test.ts' 2>&1 | grep -E '^# (tests|pass|fail)'
```
Expected: a vitest summary line like `Tests  NNNN passed`, the `REGISTERED_TOOL_COUNT = <n>;` line (161 at time of writing; `tools/list` returns two fewer than it because `health` and `index_status` register inline in `cli.ts`), and `# tests 1507` / `# fail 0` (or the current counts; write down whatever prints).

- [ ] **Step 3: Write the baseline file**

```markdown
# Foundation baseline (2026-09-26, obsidian-tc 47cb24f3, alexandria-mcp 19c43c9)

| measure | value | command |
|---|---|---|
| server vitest tests passing | <N from step 2> | `cd packages/server && node ./node_modules/vitest/vitest.mjs run` |
| tool registrations | 161 | `rg -c "registerTool\(|defineTool\(" packages/server/src/tools --glob '!*test*'` |
| alexandria node --test passing | <N> | `node --test 'src/**/*.test.ts'` |
| alexandria routing nDCG@5 | 0.910 | `npm run eval:routing` |

Every existence floor in `scripts/*.mjs` cites this table.
```

- [ ] **Step 4: Commit**

```bash
git add docs/catalog/BASELINE.md
git commit --signoff -m "docs(foundation): record the baseline counts the migration invariants compare against"
```

---

### Task 1: Catalog snapshot gate (before anything moves)

**Files:**
- Create: `scripts/catalog-snapshot.mjs`, `scripts/catalog-snapshot.test.mjs`, `docs/catalog/tools.snapshot.json`
- Modify: `package.json` (scripts), `.github/workflows/ci-server.yml` (new step in `build-test`)

**Interfaces:**
- Produces: `bun run catalog:snapshot` (writes) and `bun run catalog:check` (diffs, exit 1 on any difference). Later tasks run `catalog:check` as their invariant.

- [ ] **Step 1: Find the exact zero-config server invocation**

Run: `rg -n -A6 'zero-config-smoke:' .github/workflows/ci-server.yml | rg 'run:|cli.js|serve'`
Expected: the command CI already uses to start the server with no config (a `bun packages/server/dist/cli.js …` or `node …` line). Copy it verbatim into `SERVER_CMD` in step 3.

- [ ] **Step 2: Write the failing test**

`scripts/catalog-snapshot.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, assertFloor } from "./catalog-snapshot.mjs";

test("canonicalize sorts tools by name and drops volatile fields", () => {
  const out = canonicalize({
    tools: [{ name: "b", description: "B", inputSchema: {} }, { name: "a", description: "A", inputSchema: {} }],
    resources: [{ uri: "obsidian-tc://catalog", name: "catalog" }],
  });
  assert.deepEqual(out.tools.map((t) => t.name), ["a", "b"]);
  assert.equal(Object.keys(out).join(","), "resources,tools");
});

test("assertFloor rejects fewer than 150 tools", () => {
  assert.throws(() => assertFloor({ tools: new Array(149).fill({ name: "x" }), resources: [] }), /below floor/);
  assert.doesNotThrow(() => assertFloor({ tools: new Array(150).fill({ name: "x" }), resources: [] }));
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test scripts/catalog-snapshot.test.mjs`
Expected: FAIL, `Cannot find module './catalog-snapshot.mjs'`.

- [ ] **Step 4: Write the script**

`scripts/catalog-snapshot.mjs`:
```js
#!/usr/bin/env node
// Catalog snapshot gate: the MCP tools/list + resources/list of the server, canonicalised, must be
// byte-identical across the foundation PRs. Spawns the server exactly as ci-server's
// zero-config-smoke job does and speaks JSON-RPC over stdio.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SNAPSHOT = "docs/catalog/tools.snapshot.json";
const TOOL_FLOOR = 150; // REGISTERED_TOOL_COUNT minus the two inline tools, rounded down; see BASELINE.md
// Copy the zero-config-smoke command from ci-server.yml verbatim, split into argv:
const SERVER_CMD = ["bun", "packages/server/dist/cli.js", "serve", "--transport", "stdio"];

export function canonicalize(lists) {
  const tools = [...lists.tools]
    .map(({ name, description, inputSchema, outputSchema, annotations }) => ({ name, description, inputSchema, outputSchema, annotations }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const resources = [...(lists.resources ?? [])]
    .map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType }))
    .sort((a, b) => a.uri.localeCompare(b.uri));
  return { resources, tools };
}

export function assertFloor(lists) {
  if (lists.tools.length < TOOL_FLOOR) throw new Error(`tools/list returned ${lists.tools.length}, below floor ${TOOL_FLOOR}`);
}

async function capture() {
  const child = spawn(SERVER_CMD[0], SERVER_CMD.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let id = 0;
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
    }
  });
  const call = (method, params = {}) => new Promise((resolve) => {
    const myId = ++id; pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "catalog-snapshot", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = await call("tools/list");
  const resources = await call("resources/list");
  child.kill();
  return canonicalize({ tools: tools.tools, resources: resources.resources ?? [] });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  const now = await capture();
  assertFloor(now);
  const text = JSON.stringify(now, null, 2) + "\n";
  if (!check) { mkdirSync(dirname(SNAPSHOT), { recursive: true }); writeFileSync(SNAPSHOT, text); console.log(`wrote ${SNAPSHOT}: ${now.tools.length} tools, ${now.resources.length} resources`); }
  else if (readFileSync(SNAPSHOT, "utf8") !== text) { console.error(`catalog drift: ${SNAPSHOT} differs from the live server (run: bun run catalog:snapshot and inspect the diff)`); process.exit(1); }
  else console.log(`catalog identical: ${now.tools.length} tools, ${now.resources.length} resources`);
}
```

- [ ] **Step 5: Run the tests, then the script for real**

Run: `node --test scripts/catalog-snapshot.test.mjs && bun run build && node scripts/catalog-snapshot.mjs && node scripts/catalog-snapshot.mjs --check`
Expected: 2 tests pass; `wrote docs/catalog/tools.snapshot.json: 161 tools, N resources`; then `catalog identical`. If the server needs a flag other than the one copied, the `initialize` call hangs: kill it, re-read step 1, fix `SERVER_CMD`.

- [ ] **Step 6: Wire the scripts and the CI step**

Add to root `package.json` scripts: `"catalog:snapshot": "node scripts/catalog-snapshot.mjs"` and `"catalog:check": "node scripts/catalog-snapshot.mjs --check"`. In `.github/workflows/ci-server.yml`, in the `build-test` job after the build step and only on `ubuntu-latest`, add:
```yaml
      - name: Catalog byte-identity gate
        if: matrix.os == 'ubuntu-latest'
        run: bun run catalog:check
```
Also add `scripts/catalog-snapshot.test.mjs` to whatever glob `bun run test:scripts` uses (check `package.json` `test:scripts`).

- [ ] **Step 7: Commit and open PR A-1**

```bash
git add scripts/catalog-snapshot.mjs scripts/catalog-snapshot.test.mjs docs/catalog/tools.snapshot.json package.json .github/workflows/ci-server.yml
git commit --signoff -m "ci(catalog): byte-identity gate for tools/list and resources/list, floor 150"
```

---

### Task 2: Rename the repo and relicense to MIT (spec step 1)

**Files:**
- Modify: `LICENSE`, `README.md`, `SECURITY.md`, every `packages/*/package.json`, root `package.json`
- Create: `scripts/check-license-coherence.mjs`, `scripts/check-license-coherence.test.mjs`
- Modify: `.github/workflows/ci-version.yml` (new step)

**Interfaces:**
- Produces: `bun run check:license` gate; the repo answers to `The-40-Thieves/alexandria-tc`.

- [ ] **Step 1: Owner action, rename on GitHub**

The owner (or the agent, if the classifier allows) runs:
```bash
gh repo rename alexandria-tc --repo The-40-Thieves/obsidian-tc --yes
cd ~/src/obsidian-tc && git remote set-url origin git@github.com:The-40-Thieves/alexandria-tc.git && git fetch origin && git status -sb
```
Expected: `## main...origin/main`. The old URL keeps redirecting; the trusted-publisher binding is verified in Task 16, not here.

- [ ] **Step 2: Write the failing license test**

`scripts/check-license-coherence.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { findLicenseDrift } from "./check-license-coherence.mjs";

test("reports a package whose license is not MIT", () => {
  const drift = findLicenseDrift({ "packages/x/package.json": { license: "AGPL-3.0-only" }, "package.json": { license: "MIT" } }, "MIT License\n");
  assert.deepEqual(drift, ["packages/x/package.json: AGPL-3.0-only"]);
});
test("reports a root LICENSE that is not MIT text", () => {
  const drift = findLicenseDrift({ "package.json": { license: "MIT" } }, "GNU AFFERO GENERAL PUBLIC LICENSE");
  assert.deepEqual(drift, ["LICENSE: not MIT text"]);
});
test("floor: refuses to pass with fewer than 5 manifests", () => {
  assert.throws(() => findLicenseDrift({ "package.json": { license: "MIT" } }, "MIT License", { floor: 5 }), /below floor/);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test scripts/check-license-coherence.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 4: Write the gate**

`scripts/check-license-coherence.mjs`:
```js
#!/usr/bin/env node
// License-coherence gate: MIT everywhere (spec §1 decision 3). Reads the root LICENSE and every
// package.json the workspace lists; fails naming each manifest that disagrees.
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

const FLOOR = 5; // root + server + shared + native + plugin at minimum (BASELINE.md)

export function findLicenseDrift(manifests, licenseText, { floor = FLOOR } = {}) {
  const names = Object.keys(manifests);
  if (names.length < floor) throw new Error(`manifests found ${names.length}, below floor ${floor}`);
  const drift = [];
  if (!/^MIT License/m.test(licenseText)) drift.push("LICENSE: not MIT text");
  for (const [file, pkg] of Object.entries(manifests)) if (pkg.license !== "MIT") drift.push(`${file}: ${pkg.license ?? "missing"}`);
  return drift;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = ["package.json", ...globSync("packages/*/package.json")];
  const manifests = Object.fromEntries(files.map((f) => [f, JSON.parse(readFileSync(f, "utf8"))]));
  const drift = findLicenseDrift(manifests, readFileSync("LICENSE", "utf8"));
  if (drift.length) { console.error("license drift:\n  " + drift.join("\n  ")); process.exit(1); }
  console.log(`license coherent: ${files.length} manifests MIT`);
}
```

- [ ] **Step 5: Relicense**

Run:
```bash
curl -fsSL https://raw.githubusercontent.com/spdx/license-list-data/main/text/MIT.txt | sed '1s/.*/MIT License/' > LICENSE
sed -i '1a\
\
Copyright (c) 2026 The 40 Thieves' LICENSE
for f in package.json packages/*/package.json; do jq '.license = "MIT"' "$f" > "$f.tmp" && mv "$f.tmp" "$f"; done
biome format --write package.json packages/*/package.json
node --test scripts/check-license-coherence.test.mjs && node scripts/check-license-coherence.mjs
```
Expected: 3 tests pass; `license coherent: N manifests MIT`.

- [ ] **Step 6: Sweep the prose**

Run: `rg -n -i 'AGPL' --glob '!CHANGELOG.md' --glob '!docs/adr/**' --glob '!docs/superpowers/**' .`
Expected: hits only in README/SECURITY/docs site prose. Replace each with MIT wording (README license section: "MIT, see LICENSE"). Re-run until the command prints nothing. Add a one-line CHANGELOG entry under Unreleased: `Relicensed from AGPL-3.0-only to MIT (sole copyright holder).`

- [ ] **Step 7: Wire the gate and rename references**

Add `"check:license": "node scripts/check-license-coherence.mjs"` to root scripts and a step in `.github/workflows/ci-version.yml` next to `check:version`. Then `rg -n 'The-40-Thieves/obsidian-tc' --glob '!CHANGELOG.md' -l` and replace with `The-40-Thieves/alexandria-tc` in workflows, README badges and `server.json` `repository` (not the npm name yet; that is Task 14). Run `bun run check:public-text && bun run check:mcp-name`.

- [ ] **Step 8: Verify invariants and commit PR A-2**

Run: `just test 2>&1 | tail -3 && bun run catalog:check`
Expected: the test count from BASELINE.md, and `catalog identical`.
```bash
git add LICENSE README.md SECURITY.md CHANGELOG.md package.json packages/*/package.json server.json scripts/check-license-coherence.mjs scripts/check-license-coherence.test.mjs .github/workflows
git commit --signoff -m "chore(license): relicense to MIT and add the license-coherence gate; repo renamed to alexandria-tc"
```

---

### Task 3: Scaffold `packages/core` (spec step 2, part 1)

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/src/index.test.ts`
- Modify: root `package.json` (`workspaces`)

**Interfaces:**
- Produces: package `@the-40-thieves/alexandria-tc-core` with subpath exports `./db/*`, `./search/*`, `./embeddings/*`, `./graph/*` resolving to `src/<dir>/<file>.ts` (Bun and the server's vitest both run TypeScript source; the build step emits `dist` with the same subpaths).

- [ ] **Step 1: Write the failing test**

`packages/core/src/index.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { CORE_PACKAGE_NAME } from "./index";
describe("core package", () => {
  it("names itself", () => expect(CORE_PACKAGE_NAME).toBe("@the-40-thieves/alexandria-tc-core"));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/core 2>/dev/null || echo "no package yet"`
Expected: `no package yet`.

- [ ] **Step 3: Create the package**

`packages/core/package.json`:
```json
{
  "name": "@the-40-thieves/alexandria-tc-core",
  "version": "1.31.3",
  "private": true,
  "license": "MIT",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./db/*": "./src/db/*.ts",
    "./search/*": "./src/search/*.ts",
    "./embeddings/*": "./src/embeddings/*.ts",
    "./graph/*": "./src/graph/*.ts"
  },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit -p tsconfig.json" },
  "dependencies": { "@the-40-thieves/obsidian-tc-shared": "workspace:*" },
  "devDependencies": { "vitest": "catalog:", "typescript": "catalog:" }
}
```
`packages/core/tsconfig.json`: copy `packages/server/tsconfig.json` and set `"rootDir": "src"`, `"outDir": "dist"`. `packages/core/src/index.ts`:
```ts
export const CORE_PACKAGE_NAME = "@the-40-thieves/alexandria-tc-core";
```
Root `package.json`: add `"packages/core"` to `workspaces` and, if no `catalog` exists yet, add
```json
"workspaces": { "packages": ["packages/server", "packages/plugin", "packages/native", "packages/shared", "packages/core"], "catalog": { "vitest": "<version from packages/server/package.json>", "typescript": "<same>", "zod": "<same>" } }
```
keeping every existing version exactly as the server pins it.

- [ ] **Step 4: Install and run the test**

Run: `bun install && cd packages/core && bunx vitest run`
Expected: 1 test passes; `bun.lock` shows the new workspace.

- [ ] **Step 5: Commit**

```bash
git add packages/core package.json bun.lock
git commit --signoff -m "chore(core): scaffold @the-40-thieves/alexandria-tc-core as a private workspace with subpath exports"
```

---

### Task 4: Move `db/ search/ embeddings/ graph/` into core with history (spec step 2, part 2)

**Files:**
- Move: `packages/server/src/{db,search,embeddings,graph}` → `packages/core/src/{db,search,embeddings,graph}` (one commit each)
- Modify: every importing file under `packages/server/src` (codemod), `packages/server/package.json` (dependency), `.dependency-cruiser.cjs`, `packages/server/vitest.config.*`, `scripts/check-facade-parity.mjs` if it names these paths, `TREE.md`

**Interfaces:**
- Consumes: Task 3's subpath exports.
- Produces: server imports of the form `@the-40-thieves/alexandria-tc-core/db/types`.

- [ ] **Step 1: Move one directory with history and codemod its imports**

For `db` first:
```bash
git mv packages/server/src/db packages/core/src/db
# rewrite relative imports of db/* anywhere in the server to the package subpath
rg -l 'from "(\.\./)+db(/[^"]*)?"' packages/server/src | xargs sed -i -E 's#from "(\.\./)+db(/[^"]*)?"#from "@the-40-thieves/alexandria-tc-core/db\2"#g'
# inside core, db files that imported siblings via ../shared or ../../shared now import the package
rg -l 'from "(\.\./)+shared' packages/core/src/db | xargs -r sed -i -E 's#from "(\.\./)+shared/src/([^"]*)"#from "@the-40-thieves/obsidian-tc-shared/\2"#g'
```
Add `"@the-40-thieves/alexandria-tc-core": "workspace:*"` to `packages/server/package.json` dependencies and run `bun install`.

- [ ] **Step 2: Make the moved tests run from core**

The moved `*.test.ts` files came along. Run: `cd packages/core && bunx vitest run 2>&1 | tail -3`
Expected: the db tests pass in their new home. If a test imports a server-only helper, move that helper too (it belongs with db) rather than reaching back into the server.

- [ ] **Step 3: Run the server suite and the catalog gate**

Run: `just test 2>&1 | tail -3 && bun run catalog:check && bun run config:schema:check`
Expected: BASELINE test count (server count may drop by the number of db tests, which now run in core; the sum across packages equals the baseline), `catalog identical`, schema unchanged. Record the split in `docs/catalog/BASELINE.md`.

- [ ] **Step 4: Commit the db move**

```bash
git add -u packages/server/src packages/core/src/db packages/server/package.json bun.lock docs/catalog/BASELINE.md
git commit --signoff -m "refactor(core): move db/ into packages/core with history; server imports the package subpath"
```

- [ ] **Step 5: Repeat steps 1–4 for `search`, then `embeddings`, then `graph`**

Same three commands with the directory name substituted; one commit per directory:
```bash
for d in search embeddings graph; do
  git mv packages/server/src/$d packages/core/src/$d
  rg -l "from \"(\.\./)+$d(/[^\"]*)?\"" packages/server/src | xargs sed -i -E "s#from \"(\.\./)+$d(/[^\"]*)?\"#from \"@the-40-thieves/alexandria-tc-core/$d\2\"#g"
  just test 2>&1 | tail -3 && bun run catalog:check || exit 1
  git add -u packages/server/src packages/core/src/$d && git commit --signoff -m "refactor(core): move $d/ into packages/core with history"
done
```
Cross-references between the four directories inside core (`../db/types` from search) keep working because they moved together.

- [ ] **Step 6: Re-point the gates that name paths**

Run: `rg -n 'packages/server/src/(db|search|embeddings|graph)' .dependency-cruiser.cjs scripts/*.mjs packages/server/vitest.config.* .github/workflows/*.yml`
Expected: a list of lines. Edit each to `packages/core/src/…`. Then `bun run check:boundaries && bun run check:facade-parity && just map && just map-check`.

- [ ] **Step 7: Verify history followed**

Run: `git log --follow --oneline packages/core/src/db/open.ts | wc -l`
Expected: more than 1 (the file's pre-move commits are reachable).

- [ ] **Step 8: Commit gates and TREE.md; open PR B**

```bash
git add .dependency-cruiser.cjs scripts packages/server/vitest.config.* .github/workflows TREE.md docs/dependency-graph.json
git commit --signoff -m "chore(gates): point boundary, parity and map gates at packages/core"
```
PR B invariant ledger (paste into the PR body): `just test` sum = baseline; `bun run catalog:check` identical; `bun run config:schema:check` clean; `just map-check` clean; `git log --follow` on a moved file > 1.

---

### Task 5: The corpus contract package (spec step 3, part 1)

**Files:**
- Create: `packages/corpus/package.json`, `tsconfig.json`, `src/index.ts`, `src/types.ts`, `src/capabilities.ts`, `src/registry.ts`, `src/locator.ts`, tests beside each
- Modify: root `package.json` workspaces

**Interfaces:**
- Produces (used by Tasks 6–8, 10):
```ts
export interface DocMeta { id: string; locator: string; version: string; title?: string; updatedAt?: string }
export interface Doc extends DocMeta { body: string; properties: Record<string, unknown> }
export interface Hit extends DocMeta { corpus: string; score: number; snippet?: string }
export type Change = { kind: "upsert"; id: string; version: string } | { kind: "delete"; id: string } | { kind: "refused"; id: string; error: unknown };
export type AccessModel = "file" | "local-db" | "local-http" | "remote";
export type CapabilityName = "write" | "blocks" | "links" | "backlinks" | "properties" | "attachments" | "snapshots" | "library" | `app:${string}`;
export interface CorpusInfo { name: string; app: string; accessModel: AccessModel; locatorScheme: string; capabilities: CapabilityName[]; vec0: boolean }
export interface Corpus { describe(): CorpusInfo; list(opts?: { cursor?: string; filter?: { prefix?: string } }): AsyncIterable<DocMeta>; read(id: string): Promise<Doc>; search(q: { text: string; limit?: number }): Promise<Hit[]>; changes(since?: string): AsyncIterable<Change> }
export interface WriteCapability { put(id: string, doc: { body: string; properties?: Record<string, unknown> }, opts: { expectedVersion?: string }): Promise<DocMeta> }
export class VersionConflictError extends Error { constructor(public readonly id: string, public readonly expected: string | undefined, public readonly actual: string) }
export function hasCapability<K extends CapabilityName>(c: Corpus, name: K): boolean
export class CorpusRegistry { register(c: Corpus): void; get(name: string): Corpus; list(): CorpusInfo[] }
export function toLocator(scheme: string, root: string, absOrRel: string): string   // "obsidian://vault/a/b.md" style, forward slashes always
```

- [ ] **Step 1: Write the failing tests**

`packages/corpus/src/registry.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { CorpusRegistry, hasCapability, VersionConflictError } from "./index";
import type { Corpus } from "./types";

const fake = (name: string, caps: string[] = []): Corpus => ({
  describe: () => ({ name, app: "fake", accessModel: "file", locatorScheme: "fake", capabilities: caps as never, vec0: false }),
  async *list() {}, async read() { throw new Error("no"); }, async search() { return []; }, async *changes() {},
});

describe("CorpusRegistry", () => {
  it("registers and lists corpora by name", () => {
    const r = new CorpusRegistry(); r.register(fake("a")); r.register(fake("b", ["write"]));
    expect(r.list().map((c) => c.name)).toEqual(["a", "b"]);
    expect(r.get("b").describe().capabilities).toEqual(["write"]);
  });
  it("refuses a duplicate name", () => { const r = new CorpusRegistry(); r.register(fake("a")); expect(() => r.register(fake("a"))).toThrow(/already registered/); });
  it("hasCapability reads the declaration, not the shape", () => {
    const c = { ...fake("a"), put: async () => ({}) } as unknown as Corpus;
    expect(hasCapability(c, "write")).toBe(false);
  });
  it("VersionConflictError carries ids and versions", () => {
    const e = new VersionConflictError("x", "v1", "v2"); expect(e.message).toMatch(/x.*v1.*v2/);
  });
});
```
`packages/corpus/src/locator.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { toLocator } from "./locator";
describe("toLocator", () => {
  it("normalises separators and strips the root", () => {
    expect(toLocator("obsidian", "/v", "/v/a/b.md")).toBe("obsidian://a/b.md");
    expect(toLocator("obsidian", "C:\\vault", "C:\\vault\\a\\b.md")).toBe("obsidian://a/b.md");
    expect(toLocator("obsidian", "/v", "a/b.md")).toBe("obsidian://a/b.md");
  });
  it("refuses a path outside the root", () => { expect(() => toLocator("obsidian", "/v", "/etc/passwd")).toThrow(/outside/); });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/corpus 2>/dev/null || echo "no package yet"` → `no package yet`.

- [ ] **Step 3: Create the package and implement**

`packages/corpus/package.json` mirrors Task 3's with name `@the-40-thieves/alexandria-tc-corpus`, exports `".": "./src/index.ts"`, `"./file": "./src/file/index.ts"`, `"./conformance": "./src/conformance/kit.ts"`. `src/types.ts` holds the interfaces exactly as listed under Interfaces. `src/capabilities.ts`:
```ts
import type { CapabilityName, Corpus } from "./types";
export function hasCapability<K extends CapabilityName>(c: Corpus, name: K): boolean {
  return c.describe().capabilities.includes(name);
}
export class VersionConflictError extends Error {
  constructor(public readonly id: string, public readonly expected: string | undefined, public readonly actual: string) {
    super(`version conflict on ${id}: expected ${expected ?? "(none)"}, actual ${actual}`);
    this.name = "VersionConflictError";
  }
}
```
`src/registry.ts`:
```ts
import type { Corpus, CorpusInfo } from "./types";
export class CorpusRegistry {
  private readonly byName = new Map<string, Corpus>();
  register(c: Corpus): void {
    const { name } = c.describe();
    if (this.byName.has(name)) throw new Error(`corpus "${name}" already registered`);
    this.byName.set(name, c);
  }
  get(name: string): Corpus { const c = this.byName.get(name); if (!c) throw new Error(`unknown corpus "${name}"`); return c; }
  list(): CorpusInfo[] { return [...this.byName.values()].map((c) => c.describe()); }
}
```
`src/locator.ts`:
```ts
import { isAbsolute, relative, resolve, sep } from "node:path";
import { win32, posix } from "node:path";
export function toLocator(scheme: string, root: string, absOrRel: string): string {
  const isWin = /^[A-Za-z]:\\/.test(root) || /^[A-Za-z]:\\/.test(absOrRel);
  const p = isWin ? win32 : posix;
  const rootN = p.resolve(root);
  const absN = p.isAbsolute(absOrRel) ? p.resolve(absOrRel) : p.resolve(rootN, absOrRel);
  const rel = p.relative(rootN, absN);
  if (rel.startsWith("..") || p.isAbsolute(rel)) throw new Error(`path ${absOrRel} is outside root ${root}`);
  return `${scheme}://${rel.split(p.sep).join("/")}`;
}
```
`src/index.ts` re-exports all four modules. Add `"packages/corpus"` to root workspaces; `bun install`.

- [ ] **Step 4: Run tests**

Run: `cd packages/corpus && bunx vitest run`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/corpus package.json bun.lock
git commit --signoff -m "feat(corpus): the Corpus contract, capability declarations, registry and locator"
```

---

### Task 6: Conformance kit, proven on an in-memory corpus

**Files:**
- Create: `packages/corpus/src/conformance/kit.ts`, `packages/corpus/src/conformance/memory-corpus.ts`, `packages/corpus/src/conformance/kit.test.ts`

**Interfaces:**
- Produces: `runConformance(name: string, make: () => Promise<{ corpus: Corpus; seed(id: string, body: string): Promise<void>; edit(id: string, body: string): Promise<void> }>)` — registers a vitest `describe` block with the five contract cases. `MemoryCorpus` implements `Corpus & WriteCapability`.

- [ ] **Step 1: Write the kit as the failing test's subject**

`packages/corpus/src/conformance/kit.ts`:
```ts
import { describe, expect, it } from "vitest";
import { hasCapability, VersionConflictError } from "../capabilities";
import type { Corpus, WriteCapability } from "../types";

export interface Harness { corpus: Corpus; seed(id: string, body: string): Promise<void>; edit(id: string, body: string): Promise<void> }

export function runConformance(name: string, make: () => Promise<Harness>): void {
  describe(`corpus conformance: ${name}`, () => {
    it("list/read round-trip with provenance", async () => {
      const h = await make(); await h.seed("a.md", "# A\nhello");
      const metas = []; for await (const m of h.corpus.list()) metas.push(m);
      expect(metas.map((m) => m.id)).toContain("a.md");
      const doc = await h.corpus.read("a.md");
      expect(doc.body).toContain("hello"); expect(doc.locator).toMatch(/^[a-z-]+:\/\//); expect(doc.version).toBeTruthy();
    });
    it("search returns hits carrying corpus, id, version and locator", async () => {
      const h = await make(); await h.seed("b.md", "the quick brown fox");
      const hits = await h.corpus.search({ text: "brown", limit: 5 });
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) { expect(hit.corpus).toBe(h.corpus.describe().name); expect(hit.id).toBeTruthy(); expect(hit.version).toBeTruthy(); expect(hit.locator).toMatch(/:\/\//); }
    });
    it("changes() observes an external edit", async () => {
      const h = await make(); await h.seed("c.md", "v1");
      const before = (await h.corpus.read("c.md")).version;
      await h.edit("c.md", "v2");
      const seen = []; for await (const ch of h.corpus.changes(before)) { seen.push(ch); if (seen.length) break; }
      expect(seen[0]).toMatchObject({ kind: "upsert", id: "c.md" });
    });
    it("write refuses a stale expectedVersion (compare-and-swap)", async () => {
      const h = await make(); if (!hasCapability(h.corpus, "write")) return;
      await h.seed("d.md", "v1"); const stale = (await h.corpus.read("d.md")).version;
      await h.edit("d.md", "v2");
      const w = h.corpus as Corpus & WriteCapability;
      await expect(w.put("d.md", { body: "v3" }, { expectedVersion: stale })).rejects.toBeInstanceOf(VersionConflictError);
      expect((await h.corpus.read("d.md")).body).toBe("v2");
    });
    it("undeclared capabilities are absent", async () => {
      const h = await make(); const info = h.corpus.describe();
      for (const cap of ["write", "links", "backlinks", "properties"] as const) {
        if (!info.capabilities.includes(cap)) expect((h.corpus as Record<string, unknown>)[cap === "write" ? "put" : cap]).toBeUndefined();
      }
    });
  });
}
```

- [ ] **Step 2: Write the in-memory corpus and the kit's own test**

`packages/corpus/src/conformance/memory-corpus.ts`:
```ts
import { createHash } from "node:crypto";
import { VersionConflictError } from "../capabilities";
import type { Change, Corpus, CorpusInfo, Doc, DocMeta, Hit, WriteCapability } from "../types";

const v = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export class MemoryCorpus implements Corpus, WriteCapability {
  private docs = new Map<string, string>();
  private log: Change[] = [];
  constructor(private readonly name = "memory") {}
  describe(): CorpusInfo { return { name: this.name, app: "memory", accessModel: "file", locatorScheme: "memory", capabilities: ["write"], vec0: false }; }
  private meta(id: string, body: string): DocMeta { return { id, locator: `memory://${id}`, version: v(body) }; }
  async *list(): AsyncIterable<DocMeta> { for (const [id, body] of this.docs) yield this.meta(id, body); }
  async read(id: string): Promise<Doc> { const b = this.docs.get(id); if (b === undefined) throw new Error(`not found: ${id}`); return { ...this.meta(id, b), body: b, properties: {} }; }
  async search(q: { text: string; limit?: number }): Promise<Hit[]> {
    return [...this.docs].filter(([, b]) => b.includes(q.text)).slice(0, q.limit ?? 10).map(([id, b]) => ({ ...this.meta(id, b), corpus: this.name, score: 1 }));
  }
  async *changes(since?: string): AsyncIterable<Change> { for (const c of this.log) yield c; }
  async put(id: string, doc: { body: string }, opts: { expectedVersion?: string }): Promise<DocMeta> {
    const cur = this.docs.get(id); const actual = cur === undefined ? "" : v(cur);
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== actual) throw new VersionConflictError(id, opts.expectedVersion, actual);
    this.docs.set(id, doc.body); const m = this.meta(id, doc.body); this.log.push({ kind: "upsert", id, version: m.version }); return m;
  }
  /** test hook: an edit that bypasses put(), like another app writing the file */
  external(id: string, body: string): void { this.docs.set(id, body); this.log.push({ kind: "upsert", id, version: v(body) }); }
}
```
`packages/corpus/src/conformance/kit.test.ts`:
```ts
import { runConformance } from "./kit";
import { MemoryCorpus } from "./memory-corpus";
runConformance("MemoryCorpus", async () => {
  const corpus = new MemoryCorpus();
  return { corpus, seed: async (id, body) => { await corpus.put(id, { body }, {}); }, edit: async (id, body) => corpus.external(id, body) };
});
```

- [ ] **Step 3: Run the kit against the memory corpus**

Run: `cd packages/corpus && bunx vitest run src/conformance`
Expected: 5 tests pass. Then break `MemoryCorpus.put` by deleting the conflict check, re-run, and confirm exactly the compare-and-swap case fails; restore it. (Watch it fail for the right reason.)

- [ ] **Step 4: Commit**

```bash
git add packages/corpus/src/conformance
git commit --signoff -m "feat(corpus): conformance kit with five contract cases, proven on MemoryCorpus"
```

---

### Task 7: `FileCorpus` from the moved file primitives (spec step 3, part 2)

**Files:**
- Move: `packages/server/src/vault/{notes-io,paths,watcher}.ts` (+ their `.test.ts`) → `packages/corpus/src/file/`
- Create: `packages/corpus/src/file/file-corpus.ts`, `packages/corpus/src/file/file-corpus.test.ts`, `packages/corpus/src/file/index.ts`
- Create (re-exports): `packages/server/src/vault/notes-io.ts`, `paths.ts`, `watcher.ts` as one-liners

**Interfaces:**
- Consumes: `readNote(abs): { raw; hash }`, `writeNoteAtomic(abs, content, createDirs?)`, `noteExists(abs)`, `statNote(abs)`, `resolveVaultPathChecked(root, rel)`, `contentHash(content)`, `WatchResolution` from the moved modules; `toLocator` from Task 5.
- Produces: `class FileCorpus implements Corpus, WriteCapability` with `constructor(opts: { name: string; app: string; root: string; scheme: string; extensions?: string[] })`; `protected resolve(id): string` (absolute path via `resolveVaultPathChecked`); `protected parse(raw): { body; properties }` (identity here; Task 8 overrides).

- [ ] **Step 1: Move the primitives with history and leave re-exports**

```bash
mkdir -p packages/corpus/src/file
for f in notes-io paths watcher; do git mv packages/server/src/vault/$f.ts packages/corpus/src/file/$f.ts; [ -f packages/server/src/vault/$f.test.ts ] && git mv packages/server/src/vault/$f.test.ts packages/corpus/src/file/$f.test.ts; done
printf 'export * from "@the-40-thieves/alexandria-tc-corpus/file/notes-io";\n' > packages/server/src/vault/notes-io.ts
printf 'export * from "@the-40-thieves/alexandria-tc-corpus/file/paths";\n' > packages/server/src/vault/paths.ts
printf 'export * from "@the-40-thieves/alexandria-tc-corpus/file/watcher";\n' > packages/server/src/vault/watcher.ts
```
Add exports `"./file/*": "./src/file/*.ts"` to `packages/corpus/package.json`, `"@the-40-thieves/alexandria-tc-corpus": "workspace:*"` to the server's dependencies, and fix the moved files' own imports (`@the-40-thieves/obsidian-tc-shared` stays; a `./paths` sibling import still resolves). `bun install`.

- [ ] **Step 2: Run the moved tests and the server suite**

Run: `cd packages/corpus && bunx vitest run src/file && cd ../.. && just test 2>&1 | tail -3 && bun run catalog:check`
Expected: notes-io/paths/watcher tests pass in corpus; server sum unchanged; catalog identical. The hard-link refusal test (Review Focus 1) must be among the passing corpus tests: `bunx vitest run src/file -t "hard link"` lists at least one.

- [ ] **Step 3: Write the failing FileCorpus test**

`packages/corpus/src/file/file-corpus.test.ts`:
```ts
import { mkdtempSync, writeFileSync, mkdirSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runConformance } from "../conformance/kit";
import { FileCorpus } from "./file-corpus";

const fresh = () => { const root = mkdtempSync(join(tmpdir(), "fc-")); mkdirSync(join(root, "sub"), { recursive: true }); return root; };

runConformance("FileCorpus", async () => {
  const root = fresh(); const corpus = new FileCorpus({ name: "t", app: "markdown", root, scheme: "file" });
  return { corpus, seed: async (id, body) => { await corpus.put(id, { body }, {}); }, edit: async (id, body) => { writeFileSync(join(root, id), body); } };
});

describe("FileCorpus specifics", () => {
  it("refuses a hard-linked note (nlink > 1)", async () => {
    const root = fresh(); writeFileSync(join(root, "real.md"), "x"); linkSync(join(root, "real.md"), join(root, "alias.md"));
    const c = new FileCorpus({ name: "t", app: "markdown", root, scheme: "file" });
    await expect(c.read("alias.md")).rejects.toThrow();
  });
  it("locators use forward slashes under the scheme", async () => {
    const root = fresh(); const c = new FileCorpus({ name: "t", app: "markdown", root, scheme: "file" });
    await c.put("sub/n.md", { body: "y" }, {});
    expect((await c.read("sub/n.md")).locator).toBe("file://sub/n.md");
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd packages/corpus && bunx vitest run src/file/file-corpus` → FAIL, module not found.

- [ ] **Step 5: Implement FileCorpus**

`packages/corpus/src/file/file-corpus.ts`:
```ts
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { VersionConflictError } from "../capabilities";
import { toLocator } from "../locator";
import type { Change, Corpus, CorpusInfo, Doc, DocMeta, Hit, WriteCapability } from "../types";
import { noteExists, readNote, statNote, writeNoteAtomic } from "./notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPathChecked } from "./paths";

export interface FileCorpusOptions { name: string; app: string; root: string; scheme: string; extensions?: string[] }

export class FileCorpus implements Corpus, WriteCapability {
  protected readonly exts: string[];
  constructor(protected readonly opts: FileCorpusOptions) { this.exts = opts.extensions ?? [".md"]; }

  describe(): CorpusInfo {
    return { name: this.opts.name, app: this.opts.app, accessModel: "file", locatorScheme: this.opts.scheme, capabilities: ["write"], vec0: false };
  }
  protected resolve(id: string): string { return resolveVaultPathChecked(this.opts.root, normalizeVaultPath(id)).abs; }
  protected parse(raw: string): { body: string; properties: Record<string, unknown> } { return { body: raw, properties: {} }; }
  protected meta(id: string, raw: string): DocMeta {
    const st = statNote(this.resolve(id));
    return { id, locator: toLocator(this.opts.scheme, this.opts.root, id), version: contentHash(raw), updatedAt: st?.mtime?.toISOString() };
  }
  async *list(opts: { filter?: { prefix?: string } } = {}): AsyncIterable<DocMeta> {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
    for (const abs of walk(this.opts.root)) {
      const id = relative(this.opts.root, abs).split("\\").join("/");
      if (!this.exts.some((e) => id.endsWith(e))) continue;
      if (opts.filter?.prefix && !id.startsWith(opts.filter.prefix)) continue;
      yield this.meta(id, readNote(abs).raw);
    }
  }
  async read(id: string): Promise<Doc> {
    const abs = this.resolve(id); const { raw } = readNote(abs); // readNote refuses hard links and symlink aliases
    return { ...this.meta(id, raw), ...this.parse(raw) };
  }
  async search(q: { text: string; limit?: number }): Promise<Hit[]> {
    const out: Hit[] = []; const needle = q.text.toLowerCase();
    for await (const m of this.list()) {
      const raw = readNote(this.resolve(m.id)).raw;
      const at = raw.toLowerCase().indexOf(needle);
      if (at >= 0) out.push({ ...m, corpus: this.opts.name, score: 1, snippet: raw.slice(Math.max(0, at - 40), at + 80) });
      if (out.length >= (q.limit ?? 10)) break;
    }
    return out;
  }
  async *changes(since?: string): AsyncIterable<Change> {
    // Foundation semantics: a version-diff poll over list(); the fs watcher is wired in sub-project 2.
    for await (const m of this.list()) if (m.version !== since) yield { kind: "upsert", id: m.id, version: m.version };
  }
  async put(id: string, doc: { body: string }, opts: { expectedVersion?: string }): Promise<DocMeta> {
    const abs = this.resolve(id);
    const actual = noteExists(abs).exists ? contentHash(readNote(abs).raw) : "";
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== actual) throw new VersionConflictError(id, opts.expectedVersion, actual);
    writeNoteAtomic(abs, doc.body, true);
    return this.meta(id, doc.body);
  }
}
```
Check the field name on `ResolvedVaultPath` (`abs` or `absolute`) with `rg -n "interface ResolvedVaultPath" -A6 packages/corpus/src/file/paths.ts` and use the real one. `src/file/index.ts` exports `FileCorpus` and re-exports the three primitives.

- [ ] **Step 6: Run the tests**

Run: `cd packages/corpus && bunx vitest run` → conformance (5) + specifics (2) + moved primitive tests pass.

- [ ] **Step 7: Commit and open PR C-1**

```bash
git add packages/corpus packages/server/src/vault/notes-io.ts packages/server/src/vault/paths.ts packages/server/src/vault/watcher.ts packages/server/package.json bun.lock TREE.md docs/dependency-graph.json
git commit --signoff -m "feat(corpus): FileCorpus over the moved fd-safe file primitives; server re-exports keep every tool import unchanged"
```
Run `just map` before the commit and include `TREE.md`.

---

### Task 8: `packages/corpus-obsidian` — the vault as a corpus (spec step 3, part 3)

**Files:**
- Move: `packages/server/src/vault/{frontmatter,links,tags,registry,persist-note}.ts` (+ tests) and `packages/server/src/formats/` → `packages/corpus-obsidian/src/`
- Create: `packages/corpus-obsidian/package.json`, `tsconfig.json`, `src/index.ts`, `src/obsidian-corpus.ts`, `src/obsidian-corpus.test.ts`
- Create (re-exports): the five `packages/server/src/vault/*.ts` one-liners and `packages/server/src/formats/index.ts`

**Interfaces:**
- Consumes: `FileCorpus` (Task 7), `parseNote(raw, path?): ParsedNote`, `serializeNote(...)`, `extractLinks(body): ExtractedLink[]`, `ResolvedVault`.
- Produces: `class ObsidianCorpus extends FileCorpus` with capabilities `["write","links","properties","app:obsidian"]`, `outgoing(id): Promise<string[]>`, `properties(id): Promise<Record<string, unknown>>`; `fromResolvedVault(v: ResolvedVault, vec0: boolean): ObsidianCorpus`.

- [ ] **Step 1: Move with history, leave re-exports, scaffold the package**

```bash
mkdir -p packages/corpus-obsidian/src
for f in frontmatter links tags registry persist-note; do git mv packages/server/src/vault/$f.ts packages/corpus-obsidian/src/$f.ts; ls packages/server/src/vault/$f.test.ts >/dev/null 2>&1 && git mv packages/server/src/vault/$f.test.ts packages/corpus-obsidian/src/$f.test.ts; printf 'export * from "@the-40-thieves/alexandria-tc-corpus-obsidian/%s";\n' $f > packages/server/src/vault/$f.ts; done
git mv packages/server/src/formats packages/corpus-obsidian/src/formats
mkdir -p packages/server/src/formats && printf 'export * from "@the-40-thieves/alexandria-tc-corpus-obsidian/formats/index";\n' > packages/server/src/formats/index.ts
```
`package.json` name `@the-40-thieves/alexandria-tc-corpus-obsidian`, private, exports `".": "./src/index.ts"`, `"./*": "./src/*.ts"`, `"./formats/*": "./src/formats/*.ts"`, dependencies on `alexandria-tc-corpus`, `alexandria-tc-core`, `obsidian-tc-shared` (`workspace:*`). Add to root workspaces and the server's dependencies; `bun install`. Fix the moved files' relative imports of `./notes-io`/`./paths` to `@the-40-thieves/alexandria-tc-corpus/file/...`.

- [ ] **Step 2: Prove zero behaviour change before adding anything**

Run: `just test 2>&1 | tail -3 && bun run catalog:check && bun run check:boundaries`
Expected: sum = baseline; identical; boundaries clean (add `packages/corpus-obsidian/src` to any dependency-cruiser include list the same way Task 4 step 6 did).

- [ ] **Step 3: Write the failing ObsidianCorpus test**

`packages/corpus-obsidian/src/obsidian-corpus.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runConformance } from "@the-40-thieves/alexandria-tc-corpus/conformance";
import { ObsidianCorpus } from "./obsidian-corpus";

const make = () => new ObsidianCorpus({ name: "main", app: "obsidian", root: mkdtempSync(join(tmpdir(), "ov-")), scheme: "obsidian" }, { vec0: false });

runConformance("ObsidianCorpus", async () => {
  const corpus = make(); const root = corpus.root;
  return { corpus, seed: async (id, body) => { await corpus.put(id, { body }, {}); }, edit: async (id, body) => writeFileSync(join(root, id), body) };
});

describe("ObsidianCorpus", () => {
  it("declares links and properties and reports vec0", () => {
    const info = make().describe();
    expect(info.capabilities).toEqual(["write", "links", "properties", "app:obsidian"]); expect(info.vec0).toBe(false);
  });
  it("parses frontmatter into properties and extracts wikilinks", async () => {
    const c = make(); await c.put("n.md", { body: "---\ntags: [a]\n---\nsee [[Other]] and [[Sub/Deep|alias]]" }, {});
    expect(await c.properties("n.md")).toMatchObject({ tags: ["a"] });
    expect(await c.outgoing("n.md")).toEqual(["Other", "Sub/Deep"]);
  });
});
```

- [ ] **Step 4: Run to verify it fails** — `cd packages/corpus-obsidian && bunx vitest run src/obsidian-corpus` → FAIL, module not found.

- [ ] **Step 5: Implement**

`packages/corpus-obsidian/src/obsidian-corpus.ts`:
```ts
import { FileCorpus, type FileCorpusOptions } from "@the-40-thieves/alexandria-tc-corpus/file";
import type { CorpusInfo } from "@the-40-thieves/alexandria-tc-corpus";
import { parseNote } from "./frontmatter";
import { extractLinks } from "./links";
import type { ResolvedVault } from "./registry";

export class ObsidianCorpus extends FileCorpus {
  constructor(opts: FileCorpusOptions, private readonly flags: { vec0: boolean }) { super(opts); }
  get root(): string { return this.opts.root; }
  describe(): CorpusInfo {
    return { ...super.describe(), capabilities: ["write", "links", "properties", "app:obsidian"], vec0: this.flags.vec0 };
  }
  protected parse(raw: string): { body: string; properties: Record<string, unknown> } {
    const p = parseNote(raw); return { body: p.body, properties: p.frontmatter ?? {} };
  }
  async properties(id: string): Promise<Record<string, unknown>> { return (await this.read(id)).properties; }
  async outgoing(id: string): Promise<string[]> { return extractLinks((await this.read(id)).body).map((l) => l.target); }
}
export function fromResolvedVault(v: ResolvedVault, vec0: boolean): ObsidianCorpus {
  return new ObsidianCorpus({ name: v.id, app: "obsidian", root: v.root, scheme: "obsidian" }, { vec0 });
}
```
Check `ParsedNote`'s field names (`body`, `frontmatter`) and `ExtractedLink.target` with `rg -n "interface ParsedNote|interface ExtractedLink" -A8 packages/corpus-obsidian/src/{frontmatter,links}.ts` and match them. `src/index.ts` exports `ObsidianCorpus`, `fromResolvedVault` and re-exports the moved modules.

- [ ] **Step 6: Run tests** — `bunx vitest run` in corpus-obsidian: conformance 5 + 2 specifics + moved tests pass. Break the stale-version check in `FileCorpus.put` once and confirm the ObsidianCorpus compare-and-swap case is the one that fails; restore.

- [ ] **Step 7: Register corpora in the server without exposing anything**

In the server's startup where `VaultRegistry` is built (find it: `rg -n "new VaultRegistry\(" packages/server/src`), add after construction:
```ts
import { CorpusRegistry } from "@the-40-thieves/alexandria-tc-corpus";
import { fromResolvedVault } from "@the-40-thieves/alexandria-tc-corpus-obsidian";
// Foundation: corpora are registered but no tool reads the registry yet (sub-project 2 does).
const corpora = new CorpusRegistry();
for (const v of vaultRegistry.all()) corpora.register(fromResolvedVault(v, vecAvailable));
```
where `vecAvailable` is the boolean the db layer already computes when it tries `loadVec()` (find with `rg -n "loadVec" packages/core/src/db`), and `vaultRegistry.all()` is whatever accessor lists `ResolvedVault`s (add a one-line `all()` if only `get()` exists). Log one line at startup: `corpora: <n> registered, vec0=<bool>`.

- [ ] **Step 8: Invariants and commit PR C-2**

Run: `just test 2>&1 | tail -3 && bun run catalog:check && bun run config:schema:check && just map && just map-check`
```bash
git add packages/corpus-obsidian packages/server/src/vault packages/server/src/formats packages/server/src/index.ts packages/server/package.json package.json bun.lock TREE.md docs/dependency-graph.json .dependency-cruiser.cjs
git commit --signoff -m "feat(corpus-obsidian): the vault as a corpus (links, properties, vec0 flag); registered at startup, catalog unchanged"
```

---

### Task 9: Import script and history check (spec step 4, part 1)

**Files:**
- Create: `scripts/import-alexandria.sh`, `scripts/check-import-history.mjs`, `scripts/check-import-history.test.mjs`

**Interfaces:**
- Produces: `packages/corpus-library/` populated with Alexandria's full history; `bun run check:import-history` gate.

- [ ] **Step 1: Write the failing history-check test**

`scripts/check-import-history.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSample, judge } from "./check-import-history.mjs";
test("pickSample takes 10 evenly spaced files", () => {
  const files = Array.from({ length: 100 }, (_, i) => `f${i}`);
  const s = pickSample(files, 10); assert.equal(s.length, 10); assert.equal(s[0], "f0"); assert.equal(s[9], "f90");
});
test("judge fails when any sampled file has only post-merge history", () => {
  const r = judge([{ file: "a", commitsBeforeMerge: 3 }, { file: "b", commitsBeforeMerge: 0 }], ["alexandria-v11.0.0"], ["alexandria-v11.0.0"]);
  assert.match(r.errors.join("\n"), /b: 0 pre-merge commits/);
});
test("judge fails on a missing prefixed tag", () => {
  const r = judge([{ file: "a", commitsBeforeMerge: 1 }], ["alexandria-v11.0.0"], []);
  assert.match(r.errors.join("\n"), /tag alexandria-v11.0.0 missing/);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test scripts/check-import-history.test.mjs` → module not found.

- [ ] **Step 3: Write the check and the import script**

`scripts/check-import-history.mjs`:
```js
#!/usr/bin/env node
// After the filter-repo import, prove per-file history survived: ten sampled files under
// packages/corpus-library must have commits older than the merge commit, and every alexandria-*
// tag must resolve. Run once after the import and on every PR (cheap).
import { execSync } from "node:child_process";
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const SUBDIR = "packages/corpus-library";
export function pickSample(files, n) { const step = Math.max(1, Math.floor(files.length / n)); return files.filter((_, i) => i % step === 0).slice(0, n); }
export function judge(samples, expectedTags, presentTags) {
  const errors = [];
  for (const s of samples) if (s.commitsBeforeMerge < 1) errors.push(`${s.file}: 0 pre-merge commits (history lost)`);
  for (const t of expectedTags) if (!presentTags.includes(t)) errors.push(`tag ${t} missing`);
  return { ok: errors.length === 0, errors };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const merge = sh(`git log --merges --format=%H --diff-filter=A -- ${SUBDIR}/package.json | tail -1`);
  if (!merge) { console.error("no merge commit introduced " + SUBDIR); process.exit(1); }
  const files = sh(`git ls-files ${SUBDIR}/src`).split("\n").filter(Boolean);
  if (files.length < 50) { console.error(`only ${files.length} files under ${SUBDIR}/src, below floor 50`); process.exit(1); }
  const samples = pickSample(files, 10).map((file) => ({ file, commitsBeforeMerge: Number(sh(`git log --follow --format=%H ${merge}^2 -- ${file} | wc -l`)) }));
  const present = sh("git tag --list 'alexandria-*'").split("\n").filter(Boolean);
  const r = judge(samples, ["alexandria-v11.0.0"], present);
  if (!r.ok) { console.error(r.errors.join("\n")); process.exit(1); }
  console.log(`import history intact: ${samples.length} sampled files, ${present.length} prefixed tags`);
}
```
`scripts/import-alexandria.sh`:
```bash
#!/usr/bin/env bash
# One-time: import alexandria-mcp into packages/corpus-library with full history. Run from the
# alexandria-tc repo root on a clean tree. Requires git-filter-repo (pipx install git-filter-repo).
set -euo pipefail
SRC=${1:-https://github.com/The-40-Thieves/alexandria-mcp.git}
WORK=$(mktemp -d)
git clone --no-local "$SRC" "$WORK/alexandria"
( cd "$WORK/alexandria"
  git filter-repo --to-subdirectory-filter packages/corpus-library --tag-rename v:alexandria-v )
git remote add alexandria "$WORK/alexandria"
git fetch alexandria --tags
git merge --allow-unrelated-histories --no-ff -m "chore(corpus-library): import alexandria-mcp with history (filter-repo --to-subdirectory-filter)" alexandria/main
git remote remove alexandria
echo "imported; run: bun run check:import-history"
```

- [ ] **Step 4: Run the unit tests, then the import on a fresh branch**

Run: `node --test scripts/check-import-history.test.mjs && chmod +x scripts/import-alexandria.sh && git switch -c foundation/04-import main && scripts/import-alexandria.sh && node scripts/check-import-history.mjs`
Expected: 3 tests pass; merge commit created; `import history intact: 10 sampled files, 1 prefixed tags`. Also `git log --follow --oneline packages/corpus-library/src/index.ts | wc -l` > 1.

- [ ] **Step 5: Commit the scripts (the merge commit already exists) and wire the gate**

Add `"check:import-history": "node scripts/check-import-history.mjs"` to root scripts and a step in `ci-version.yml`.
```bash
git add scripts/import-alexandria.sh scripts/check-import-history.mjs scripts/check-import-history.test.mjs package.json .github/workflows/ci-version.yml
git commit --signoff -m "chore(import): filter-repo import script and the history-intact gate"
```

---

### Task 10: Make `corpus-library` a workspace package that loads under Bun (spec step 4, part 2)

**Files:**
- Modify: `packages/corpus-library/package.json`, `packages/corpus-library/src/utils/dispatcher.ts`, `packages/corpus-library/src/utils/dispatcher.test.ts`
- Modify: root `package.json` workspaces, `justfile` (`test` recipe), `.github/workflows/ci-corpus.yml` (new)

**Interfaces:**
- Produces: `@the-40-thieves/alexandria-tc-corpus-library` (public; its `bin` `alexandria-mcp` kept so Task 15's shim can depend on it), tests green under `node --test`, `bun dist/index.js --version` works.

- [ ] **Step 1: Rename the package, keep its bin**

In `packages/corpus-library/package.json`: `name` → `@the-40-thieves/alexandria-tc-corpus-library`, `license` `MIT` (already), keep `bin: { "alexandria-mcp": "dist/index.js" }`, keep `engines.node >=24`, add `"private": false`. Remove `package-v.yml` from `packages/corpus-library/.github/` (the imported workflows are inert under a subdirectory; delete the whole `packages/corpus-library/.github` directory). Add `"packages/corpus-library"` to root workspaces; `bun install`.

- [ ] **Step 2: Write the failing Bun-compat test (Review Focus 4)**

Append to `packages/corpus-library/src/utils/dispatcher.test.ts`:
```ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";

test("without undici.cacheStores the dispatcher still installs a pinned Agent (no bare global fetch)", async () => {
  const calls: unknown[] = [];
  mock.module("undici", { namedExports: { Agent: class Agent { constructor(public o: unknown) {} }, interceptors: { dns: () => (d: unknown) => d }, setGlobalDispatcher: (d: unknown) => { calls.push(d); } } });
  const { installDispatcher } = await import("./dispatcher.ts?nocache=" + Date.now());
  installDispatcher();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.constructor?.name, "Agent");
});
```
(If `mock.module` is unavailable on the pinned Node, load the module with `cacheStores` forced off via the env switch added in step 4 instead: `ALEXANDRIA_HTTP_CACHE=off`.)

- [ ] **Step 3: Run to verify it fails** — `cd packages/corpus-library && ALEXANDRIA_STATE_DB=:memory: NODE_ENV=test node --test src/utils/dispatcher.test.ts` → FAIL (either the named import throws or `installDispatcher` is not exported).

- [ ] **Step 4: Port the one import**

In `src/utils/dispatcher.ts` replace the named import line with:
```ts
import * as undici from 'undici';
import { Agent, interceptors, setGlobalDispatcher, type Dispatcher } from 'undici';
// Bun ships its own partial `undici` (49 exports vs Node's 59; no cacheStores). The RFC 9111 cache
// is an optimisation, never a correctness requirement, so it is optional: absent, requests still go
// through the same pinned Agent (connect.lookup guard, timeouts, dns interceptor) with no cache.
const cacheStores: typeof import('undici').cacheStores | undefined = (undici as { cacheStores?: typeof import('undici').cacheStores }).cacheStores;
```
Then in the store factory (around line 154) return `undefined` when `cacheStores` is missing or `config.ALEXANDRIA_HTTP_CACHE === 'off'`, call `warnFallbackOnce('undici.cacheStores unavailable on this runtime')`, and only push `interceptors.cache({ store })` when a store exists. Export the existing install function as `installDispatcher` if it has another name (keep the old name too).

- [ ] **Step 5: Run the whole Alexandria suite under Node, then the Bun smoke**

Run:
```bash
cd packages/corpus-library && ALEXANDRIA_STATE_DB=:memory: NODE_ENV=test node --test --test-concurrency=4 'src/**/*.test.ts' 'scripts/**/*.test.ts' 2>&1 | grep -E '^# (tests|pass|fail)'
npm run build && bun dist/index.js --version && ALEXANDRIA_STATE_DB=:memory: bun dist/index.js --help | head -3
```
Expected: pass count = BASELINE (+1 new test), `# fail 0`; Bun prints the version line and help without the `cacheStores` SyntaxError.

- [ ] **Step 6: Reproduce the routing eval from the new path**

Run: `cd packages/corpus-library && ALEXANDRIA_STATE_DB=:memory: node scripts/eval-routing.ts 2>&1 | tail -5`
Expected: nDCG@5 `0.910` (or the BASELINE value) and source count ≥ 150. Record the line in `docs/catalog/BASELINE.md`.

- [ ] **Step 7: CI for the corpus packages**

`.github/workflows/ci-corpus.yml`:
```yaml
name: ci-corpus
on: { pull_request: {}, push: { branches: [main] } }
jobs:
  node:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.4.2 }
      - uses: actions/setup-node@v5
        with: { node-version: 26.5.0 }
      - run: bun install --frozen-lockfile
      - run: cd packages/corpus && npx vitest run --coverage
      - run: cd packages/corpus-obsidian && npx vitest run --coverage
      - run: cd packages/corpus-library && ALEXANDRIA_STATE_DB=:memory: NODE_ENV=test node --test --test-concurrency=4 'src/**/*.test.ts' 'scripts/**/*.test.ts'
      - run: bun run check:import-history
  bun:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.4.2 }
      - run: bun install --frozen-lockfile
      - run: bun run --filter '@the-40-thieves/alexandria-tc-corpus*' test
      - run: cd packages/corpus-library && bun run build && bun dist/index.js --version
```
Pin the action SHAs to the same ones `ci-server.yml` uses (`rg -n 'uses:' .github/workflows/ci-server.yml`). Run `bun run check:actions-shellcheck && npx actionlint`.

- [ ] **Step 8: Commit and open PR D**

```bash
git add packages/corpus-library/package.json packages/corpus-library/src/utils/dispatcher.ts packages/corpus-library/src/utils/dispatcher.test.ts package.json bun.lock .github/workflows/ci-corpus.yml docs/catalog/BASELINE.md justfile TREE.md
git rm -r -q packages/corpus-library/.github
git commit --signoff -m "feat(corpus-library): Alexandria as a workspace package; optional undici cache so it loads under Bun; ci-corpus on both runtimes"
```
Add to `justfile`'s `test` recipe a line running the corpus-library `node --test` command so `just test` stays the CI-equivalent run.

---

### Task 11: Runtime rule as a boundary gate (spec step 5)

**Files:**
- Modify: `.dependency-cruiser.cjs`, `scripts/check-boundaries.mjs` (if it lists rule names), `.github/workflows/ci-corpus.yml`

**Interfaces:**
- Produces: `bun run check:boundaries` fails on any `bun:` import outside the two allowed places.

- [ ] **Step 1: Add the rule**

In `.dependency-cruiser.cjs` `forbidden`, next to `no-tool-imports-transport`:
```js
    {
      name: "no-bun-builtins-outside-driver-seam",
      severity: "error",
      comment:
        "Every package stays Node-loadable (spec §3.4). Bun builtins are allowed only in the SQLite driver " +
        "seam and the native loader; anywhere else they break the .mcpb bundle, npx installs and the Node CI job.",
      from: { pathNot: "^(packages/core/src/db/bun-sqlite\\.ts|packages/native/)" },
      to: { path: "^bun:" },
    },
```
If dependency-cruiser does not see `bun:` specifiers as modules, set `options.doNotFollow`/`exclude` so they are kept, or add them under `options.knownViolations` for the allowed file only; confirm with the next step.

- [ ] **Step 2: Watch it fail for the right reason**

Run:
```bash
printf 'import { Database } from "bun:sqlite";\nexport const x = Database;\n' > packages/corpus/src/violation.ts
bun run check:boundaries; echo "exit=$?"
rm packages/corpus/src/violation.ts
bun run check:boundaries; echo "exit=$?"
```
Expected: first `exit=1` naming `no-bun-builtins-outside-driver-seam` and `packages/corpus/src/violation.ts`; second `exit=0`.

- [ ] **Step 3: Run the gate in ci-corpus and commit PR E**

Add `- run: bun run check:boundaries` to the `node` job in `ci-corpus.yml`.
```bash
git add .dependency-cruiser.cjs scripts/check-boundaries.mjs .github/workflows/ci-corpus.yml
git commit --signoff -m "ci(boundaries): forbid bun: builtins outside the SQLite driver seam and the native loader"
```

---

### Task 12: Rename the published identities and set 2.0.0 (spec step 6, part 1)

**Files:**
- Modify: `packages/server/package.json` (name, bin, mcpName, version), `server.json`, every workspace `version`, `.github/workflows/{publish,release-image}.yml`, `scripts/{check-version-coherence,check-mcp-name,release}.mjs` where they name `obsidian-tc`, `Dockerfile`, `smithery.yaml`/Smithery card generator, `README.md` install snippets, `CHANGELOG.md`

**Interfaces:**
- Produces: `bun run check:version && bun run check:mcp-name && bun run check:license` all green with the new names at `2.0.0`.

- [ ] **Step 1: Enumerate every site**

Run: `rg -n --glob '!CHANGELOG.md' --glob '!docs/superpowers/**' --glob '!node_modules' '"obsidian-tc"|obsidian-tc@|ghcr\.io/the-40-thieves/obsidian-tc|io\.github\.The-40-Thieves/obsidian-tc|bin/obsidian-tc|"bin": \{ "obsidian-tc"' . | cut -d: -f1 | sort | uniq -c | sort -rn`
Expected: a file list with counts. This is the edit list; keep it in the PR body.

- [ ] **Step 2: Rename**

`packages/server/package.json`: `"name": "@the-40-thieves/alexandria-tc"`, `"bin": { "alexandria-tc": "./dist/cli.js" }`, `"mcpName": "io.github.The-40-Thieves/alexandria-tc"`, `"version": "2.0.0"`. `server.json`: `"name": "io.github.The-40-Thieves/alexandria-tc"`, version `2.0.0`, packages entry `@the-40-thieves/alexandria-tc`. Every other workspace `version` → `2.0.0` (shared, native, plugin, core, corpus, corpus-obsidian; corpus-library too, so `check:version` has one number to check). `sed -i 's#ghcr.io/the-40-thieves/obsidian-tc#ghcr.io/the-40-thieves/alexandria-tc#g' .github/workflows/publish.yml .github/workflows/release-image.yml Dockerfile`. README install snippets: `npx @the-40-thieves/alexandria-tc`, `claude mcp add alexandria-tc -- npx -y @the-40-thieves/alexandria-tc`. CHANGELOG: `## 2.0.0` with the rename, the relicense and "no tool changes; see the foundation spec".

- [ ] **Step 3: Run every naming gate**

Run: `bun run check:version && bun run check:mcp-name && bun run check:license && bun run check:public-text && bun run check:bun-version && bun run config:schema:check && bun run catalog:check`
Expected: all green; catalog identical (the server's *name* is not part of `tools/list`).

- [ ] **Step 4: Commit PR F-1**

```bash
git add packages/*/package.json server.json .github/workflows/publish.yml .github/workflows/release-image.yml Dockerfile README.md CHANGELOG.md scripts
git commit --signoff -m "chore(release): rename to @the-40-thieves/alexandria-tc, registry io.github.The-40-Thieves/alexandria-tc, lockstep 2.0.0"
```

---

### Task 13: Deprecation shims (spec step 6, part 2)

**Files:**
- Create: `packages/shim-obsidian-tc/{package.json,bin.mjs,bin.test.mjs,README.md}`, `packages/shim-alexandria-mcp/{package.json,bin.mjs,bin.test.mjs,README.md}`
- Modify: root workspaces

**Interfaces:**
- Produces: `obsidian-tc@1.32.0` (bin `obsidian-tc` → `alexandria-tc`) and `@the-40-thieves/alexandria-mcp@11.1.0` (bin `alexandria-mcp` → corpus-library's `alexandria-mcp`), each printing one notice to stderr and exec'ing the real bin with the same argv.

- [ ] **Step 1: Write the failing shim test (Review Focus 5)**

`packages/shim-obsidian-tc/bin.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const bin = fileURLToPath(new URL("./bin.mjs", import.meta.url));

test("prints one rename notice and exec's the new bin with argv intact", () => {
  const r = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8", env: { ...process.env, ALEXANDRIA_TC_SHIM_TEST_TARGET: process.execPath } });
  assert.match(r.stderr, /obsidian-tc is now @the-40-thieves\/alexandria-tc/);
  assert.equal(r.status, 0);
});
test("missing target gives one clear line, not a stack trace", () => {
  const r = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8", env: { ...process.env, ALEXANDRIA_TC_SHIM_TEST_TARGET: "/nonexistent/alexandria-tc" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /install @the-40-thieves\/alexandria-tc/);
  assert.doesNotMatch(r.stderr, /at .*\.mjs:\d+/);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test packages/shim-obsidian-tc/bin.test.mjs` → module not found.

- [ ] **Step 3: Write the shim**

`packages/shim-obsidian-tc/package.json`:
```json
{ "name": "obsidian-tc", "version": "1.32.0", "license": "MIT", "type": "module", "description": "Renamed: use @the-40-thieves/alexandria-tc. This package delegates to it.",
  "bin": { "obsidian-tc": "./bin.mjs" }, "files": ["bin.mjs", "README.md"],
  "dependencies": { "@the-40-thieves/alexandria-tc": "2.0.0" }, "scripts": { "test": "node --test bin.test.mjs" } }
```
`packages/shim-obsidian-tc/bin.mjs`:
```js
#!/usr/bin/env node
// obsidian-tc was renamed to @the-40-thieves/alexandria-tc. This final release delegates every
// invocation to the new bin, prints the notice once, and exits with a clear line if the new
// package is missing (an offline install of the shim alone).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
const NEW = "@the-40-thieves/alexandria-tc";
let target = process.env.ALEXANDRIA_TC_SHIM_TEST_TARGET;
if (!target) { try { target = createRequire(import.meta.url).resolve(`${NEW}/dist/cli.js`); } catch { target = undefined; } }
process.stderr.write(`obsidian-tc is now ${NEW}; this shim delegates to it. Update your MCP config to "${NEW}".\n`);
if (!target || !existsSync(target)) { process.stderr.write(`obsidian-tc: ${NEW} is not installed. Run: npm install -g ${NEW}\n`); process.exit(2); }
const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
```
Mirror both files for `packages/shim-alexandria-mcp` with `name` `@the-40-thieves/alexandria-mcp`, version `11.1.0`, `NEW = "@the-40-thieves/alexandria-tc-corpus-library"`, target `dist/index.js`, notice `@the-40-thieves/alexandria-mcp is now part of alexandria-tc (package ${NEW})`. Add both to root workspaces. Note: `check:version` must skip the shims (they carry their own final versions); add their names to its exclusion list with a comment.

- [ ] **Step 4: Run tests** — `node --test packages/shim-obsidian-tc/bin.test.mjs packages/shim-alexandria-mcp/bin.test.mjs` → 4 pass. Then `bun run check:version` still green.

- [ ] **Step 5: Commit PR F-2**

```bash
git add packages/shim-obsidian-tc packages/shim-alexandria-mcp package.json bun.lock scripts/check-version-coherence.mjs
git commit --signoff -m "feat(shims): final obsidian-tc 1.32.0 and alexandria-mcp 11.1.0 releases that delegate to alexandria-tc"
```

---

### Task 14: Release rehearsal, the 2.0.0 cut, and the old channels (spec step 6, part 3)

**Files:**
- Modify: `docs/distribution/*` (Homebrew formula, Docker catalog yaml), `.github/workflows/publish.yml` (shim publish steps)

**Interfaces:**
- Consumes: everything above merged to `main`.
- Produces: `2.0.0` live under the new names; old names deprecated.

- [ ] **Step 1: Owner actions, bootstrap the new npm names**

For each of `@the-40-thieves/alexandria-tc` and `@the-40-thieves/alexandria-tc-corpus-library`: publish a `0.0.0-bootstrap` placeholder from Cave with `npm publish --access public --tag bootstrap` from a minimal `package.json` (trusted publishing cannot create a package), then on npmjs.com attach the trusted publisher: repository `The-40-Thieves/alexandria-tc`, workflow `publish.yml`. Verify the existing `obsidian-tc` and `@the-40-thieves/alexandria-mcp` publisher entries still list the renamed repo; if not, re-attach them.

- [ ] **Step 2: Add shim publishing to publish.yml**

After the server publish step, add two `npm publish --provenance --access public` steps run from `packages/shim-obsidian-tc` and `packages/shim-alexandria-mcp`, guarded by a `if: startsWith(github.ref, 'refs/tags/v2.0.0')` so they publish once. Run `npx actionlint`.

- [ ] **Step 3: Rehearse**

```bash
git tag -a v2.0.0-rc.1 -m "rehearsal: new names through the real workflow" && git push origin v2.0.0-rc.1
gh run watch --exit-status $(gh run list --workflow publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')
npm view @the-40-thieves/alexandria-tc@2.0.0-rc.1 version && docker pull ghcr.io/the-40-thieves/alexandria-tc:2.0.0-rc.1 >/dev/null && echo image ok
```
Expected: workflow green; npm and ghcr resolve. If the OIDC step fails with a subject mismatch, the binding did not survive the rename: re-attach the publisher (step 1) and re-run; record the outcome in `docs/catalog/BASELINE.md` under "trusted publisher after rename".

- [ ] **Step 4: Cut 2.0.0**

`node scripts/release.mjs 2.0.0` (the existing release script; it tags and pushes). Watch the run as in step 3; verify `npm view @the-40-thieves/alexandria-tc version` → `2.0.0`, `npm view obsidian-tc version` → `1.32.0`, `npm view @the-40-thieves/alexandria-mcp version` → `11.1.0`.

- [ ] **Step 5: Deprecate the old names (owner)**

```bash
npm deprecate "obsidian-tc@<1.32.0" "obsidian-tc was renamed to @the-40-thieves/alexandria-tc (2.0.0). Install that package; 1.32.0 is a shim that delegates to it."
npm deprecate "@the-40-thieves/alexandria-mcp@<11.1.0" "alexandria-mcp is now part of alexandria-tc: @the-40-thieves/alexandria-tc-corpus-library. 11.1.0 is a shim that delegates to it."
```

- [ ] **Step 6: Re-point the listings**

- MCP registry: `mcp-publisher login github --token "$(gh auth token)" && mcp-publisher publish` from the repo root (new `server.json`); then publish a final version of each old entry with `"description": "Superseded by io.github.The-40-Thieves/alexandria-tc"` (the registry has no rename).
- Docker catalog: open a new PR on `docker/mcp-registry` from the `suavecito585/mcp-registry` fork with `docs/distribution/docker-server.yaml` renamed; leave the old entry.
- Homebrew: in `The-40-Thieves/homebrew-tap`, add `alexandria-tc.rb` and mark `alexandria-mcp.rb` with `deprecate! date: "2026-10-01", because: "renamed to alexandria-tc"`.
- Smithery: `node scripts/publish-smithery.mjs` with the regenerated card.
- ghcr: push a README note on the last `obsidian-tc` tag; docs site: enable Pages on the renamed repo and leave a one-page pointer at the old project URL.

- [ ] **Step 7: Final verification and record**

Run: `npx -y @the-40-thieves/alexandria-tc --version && npx -y obsidian-tc --version 2>&1 | head -2 && bun run catalog:check`
Expected: `2.0.0`; the shim notice followed by `2.0.0`; catalog identical. Append the results to `docs/catalog/BASELINE.md` under "2.0.0 cut" and commit with `--signoff`.

---

## Self-Review

**Spec coverage.** §3.1 rename → Task 2; §3.2 import → Task 9; §3.3 layout → Tasks 3–8, 10, 13; §3.4 runtime rule → Task 11 (+ ci-corpus Node job in Task 10); §3.5 tooling (catalog, filter, lock) → Task 3 step 3 and Task 10 step 7; §4.1–4.3 contract, capabilities, provenance → Task 5; §4.4 server keeps ACL/HITL/snapshots → nothing moves them (Tasks 7–8 leave `acl-*`, `hitl`, `mode`, `snapshots`, `bulk`, `rewrite`, `prune` in the server); §4.5 base classes → `FileCorpus` in Task 7; the other three base classes are declared in the spec for later adapters and have no consumer in the foundation, so they are **not** built here (YAGNI; Task 5's `AccessModel` type reserves their names); §4.6 kit → Task 6; §5 sequence → Tasks 2, 3–4, 5–8, 9–10, 11, 12–14 in that order; §6 names/versions/bootstrap/channels → Tasks 12–14; §7 gates → Tasks 1, 2, 9, 11, plus existence floors in each script; §8 out-of-scope respected (no search wiring, no second adapter, no docs redesign); §9 done-means → Task 14 step 7; §10 open item 3 is answered by Task 10 (corpus-library is published because the shim needs it; `corpus` stays private).

**Placeholder scan.** No TBD/TODO. Two steps say "check the real field name with rg and match it" (Task 7 step 5, Task 8 step 5); those are verification instructions with the exact command, not placeholders.

**Type consistency.** `Corpus`, `DocMeta`, `Doc`, `Hit`, `Change`, `CorpusInfo`, `WriteCapability`, `VersionConflictError`, `CorpusRegistry`, `toLocator` are defined in Task 5 and used with the same names and shapes in Tasks 6, 7, 8. `runConformance(name, make)` and `Harness` are defined in Task 6 and used identically in Tasks 7 and 8. `FileCorpusOptions` is defined in Task 7 and used in Task 8. `installDispatcher` is introduced in Task 10 step 4 and tested in step 2.

**Review Focus.** 1 → Task 7 step 2 and the hard-link test in step 3; 2 → kit case in Task 6, run against `ObsidianCorpus` in Task 8 step 6; 3 → `toLocator` Windows case in Task 5; 4 → Task 10 step 2; 5 → Task 13 step 1.
