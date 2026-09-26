# alexandria-tc foundation — merging obsidian-tc and Alexandria into one repo (design)

Status: **design for owner review, not built.** Written 2026-09-26 against obsidian-tc `main`
`47cb24f3` (v1.31.3) and alexandria-mcp `main` `19c43c9` (v11.0.0). This is sub-project 1 of four;
it deliberately changes no user-visible behaviour. The other three (one search across corpora, more
note-app adapters, brand and docs) each get their own design once this one has landed.

Decisions taken in the 2026-09-26 brainstorming session, in the order they were made, are in §1.
Research that fed them is cited inline; the digests are summarised in the auto-memory note
`project_alexandria_tc_merge_design_2026_09_26` and the measurements in
`reference_bun_vs_node_measured_for_alexandria_tc_merge`.

## 0. The one-paragraph version

One repo, `The-40-Thieves/alexandria-tc`, made by **renaming** `obsidian-tc` (which keeps its
history, stars, issue links, and the npm trusted-publisher binding) and importing Alexandria's
history under `packages/corpus-library` with `git filter-repo`. MIT everywhere. Bun is the primary
runtime for development, CI and Cave; every package stays Node-loadable, which is the state
obsidian-tc's server is already in (better-sqlite3 preferred, `node:sqlite` fallback for the
`.mcpb` bundle). The product shape is **one server, many corpora**: a small `Corpus` contract every
data source implements (list, read, search, changes), plus declared capability sets (write, blocks,
links, properties, attachments, snapshots, library, `app:<name>` extensions). The Obsidian vault is
the first corpus, moved under the contract with a byte-identical tool catalog; Alexandria's 152
sources are the second family, imported and buildable but not yet wired into the server. The
foundation ends at a tagged `2.0.0` under the new names, with the two old npm names shipped as
deprecation shims.

## 1. Decisions (owner, 2026-09-26)

| # | decision | consequence carried into this design |
|---|---|---|
| 1 | Outcome: all four — one product/one search, one codebase, notes for every app, one brand | four sub-projects; this spec is the first |
| 2 | Adapter targets: local markdown apps, cloud-API apps, Apple ecosystem, outliners | the contract abstracts a document store, not a folder of markdown |
| 3 | License: **MIT for everything** | obsidian-tc has one human author (1,345 commits) plus a release bot, so no consent is needed; the change is the LICENSE file and every `license` field |
| 4 | Runtime: **Bun primary, every reusable package Node-loadable** | `bun:` imports confined to the SQLite driver seam and the native loader; a Node CI job runs every package |
| 5 | Adapter bar: **core contract, extensions optional** | capability sets; the catalog hides what a corpus cannot do |
| 6 | Old names: **rename with deprecation shims** | one final release each, `npm deprecate`, one release cycle |
| 7 | Approach: **one server, many corpora** (over two servers on a shared core, or a strangler shim) | one binary, one catalog, one facade |

## 2. Where we are (measured 2026-09-26)

| piece | obsidian-tc | alexandria-mcp |
|---|---|---|
| runtime | Bun 1.4.2 primary; server also runs on Node (`db/open.ts`: bun:sqlite → better-sqlite3 → node:sqlite) | Node 24; fails under Bun on one import (`cacheStores` from `undici`, `src/utils/dispatcher.ts`); its `node:sqlite` and `worker_threads` use already runs under Bun |
| license | AGPL-3.0-only | MIT |
| size | 438 server source files; 73 touch Obsidian-only features; 161 tools grouped by milestone (`tools/m1..m8`) | 196 source files; 6 tools (`library_research`, `library_ask`, `library_answer`, `library_citations`, `library_health`, `format`) |
| data-source abstraction | none named; `vault/` is the de-facto surface: `notes-io`, `paths`, `links`, `frontmatter`, `tags`, `watcher` (events `upsert / delete / refused`), `snapshots`, `acl-*`, `hitl`, `mode`, `registry` (`ResolvedVault`) | `SourceAdapter { description, supportsIngest, search(), read() }` plus `SourceMeta` (`kind`, `cluster`, `freshness`, `pacing`, `ingestPolicy`, `hidden`, `auth`) in `src/sources/registry.ts` |
| retrieval | `search/` (adaptive RRF, ColBERT, FTS, sqlite-vec, graph expansion, rerank, federated multi-vault fusion by rank) | `pipeline/` (semantic chunking, RRF over sources, embedding and vector-store providers); nDCG@5 0.910 on the routing eval |
| release | `publish.yml` (1,349 lines): npm OIDC, ghcr, Smithery, plugin-release mirror, version-coherence checks, `release.mjs` | Package-v bot (`package-v.yml`), npm OIDC, MCP registry, Docker catalog, MCPB bundle, Homebrew formula |
| published identity | npm `obsidian-tc` (unscoped), registry `io.github.The-40-Thieves/obsidian-tc`, `ghcr.io/the-40-thieves/obsidian-tc` | npm `@the-40-thieves/alexandria-mcp`, registry `io.github.The-40-Thieves/alexandria-mcp` |
| cold start (this box) | not measured on a built tree | Node 936 ms for `dist/index.js --version`; its dependency set loads in 695 ms under Node and 341 ms under Bun (whole process 770 vs 295 ms, hyperfine, 10 runs) |
| SQLite driver | — | `node:sqlite` vs `bun:sqlite` within ~10% on 50k inserts / 20k indexed reads; the driver is not a lever |

Runtime conclusion: neither codebase is runtime-bound (Alexandria is network-bound, obsidian-tc is
index-bound). Startup is the one place the runtime shows, and Bun is 2.6x faster there on the
measured set; it matters for stdio sessions, not for the long-lived HTTP server.

## 3. Repo layout and how it comes into being

### 3.1 Rename, do not recreate

npm trusted publishing and Sigstore provenance bind to the repository owner and name, and the MCP
registry identity is `io.github.<org>/<repo>`. A GitHub rename keeps the OIDC binding (GitHub
reissues it under the new name), redirects git remotes, issues and PR links, and keeps stars and
history; a new repo re-attaches every publisher and re-lists everything. Two things do **not**
redirect after a rename and are swept by hand: GitHub Pages project URLs and `ghcr.io` image names.
(Sources: GitHub changelog 2026-04-23 on immutable OIDC subject claims; docs.npmjs.com/trusted-publishers;
modelcontextprotocol.io/registry/about; GitHub community discussion 123611.)

So: `The-40-Thieves/obsidian-tc` → `The-40-Thieves/alexandria-tc`.

### 3.2 Import Alexandria with history

On a fresh clone of alexandria-mcp: `git filter-repo --to-subdirectory-filter packages/corpus-library`,
rename its tags with an `alexandria-` prefix (`v11.0.0` → `alexandria-v11.0.0`) so they never
collide with the notes server's `v1.x` line, then in alexandria-tc:
`git merge --allow-unrelated-histories`. This keeps `git log --follow` and `git blame` per file,
which `git subtree add` does not (newren/git-filter-repo; tomono and josh were considered and
rejected as heavier than needed for a one-time two-repo merge).

### 3.3 Layout

```
alexandria-tc/                       (renamed obsidian-tc; history intact)
  packages/
    corpus/            the contract (§4): Corpus, capability sets, four base classes, registry,
                       provenance types, conformance kit                          Node-loadable
    core/              db driver seam (bun:sqlite | better-sqlite3 | node:sqlite), search,
                       embeddings, graph, rerank, eval harness — lifted from packages/server   Node-loadable
    corpus-obsidian/   vault/, formats/, plugin bridge as a FileCorpus            Node-loadable (native optional)
    corpus-library/    Alexandria: sources/, pipeline/, web/ as a corpus family   Node-loadable (undici import ported)
    server/            MCP server, tools, transports, auth, ACL, HITL, telemetry, CLI
    native/  embedder-local/  reranker-local/  obsidian-plugin/                  unchanged
    shim-obsidian-tc/  shim-alexandria-mcp/   final releases of the old names (§6)
  docs/  eval/  .github/
```

### 3.4 Runtime rule

Everything is Node-loadable; Bun is primary. The published pattern for a package that runs on both
runtimes is runtime detection behind one interface, which is exactly obsidian-tc's driver seam;
there is no `exports`-condition trick for `bun:sqlite` versus `node:sqlite` and nobody ships one.
Bun's exports-condition order is `bun`, `node-addons`, `node`, `require`, `import`, `default`
(bun.com/docs/runtime/module-resolution). Rule: `bun:` imports are allowed only under
`packages/core/src/db` and `packages/native`; a lint enforces it; CI runs the suite under both
runtimes and the Node job publishes coverage (coverage does not work under `bun test`).

Known trap carried in on purpose: `node:sqlite` in Bun is fully implemented, but `loadExtension`
needs a full SQLite build, and on macOS Bun uses Apple's libsqlite, so vec0 needs
`Database.setCustomSQLite` (bun.com/docs/runtime/nodejs-compat; obsidian-tc's `db/bun-sqlite.ts`
already does this). Under `node:sqlite` obsidian-tc exposes no extension loading and falls back to
brute-force cosine. The core keeps that fallback as a first-class, **declared** path (a corpus
reports whether vec0 is available), not a silent one.

### 3.5 Workspace tooling

Bun workspaces with a root `catalog` for shared dependency versions (`catalog:` and `workspace:*`
are rewritten on publish), `bun run --filter '*' --parallel` for build and test, text `bun.lock`.
No Turbo, no changesets: obsidian-tc's `release.mjs`, version-coherence checks and `publish.yml`
are the release system; Alexandria's Package-v bot is retired. Both official MCP monorepos
(modelcontextprotocol/servers, cloudflare/mcp-server-cloudflare) use workspaces plus shared
`mcp-common`-style packages, so this is the conventional shape. (bun.com/docs/pm/workspaces,
/pm/catalogs, /pm/filter.)

## 4. The corpus contract

### 4.1 Core

```ts
interface Corpus {
  describe(): CorpusInfo;      // name, accessModel, capabilities, app, locatorScheme, vec0: boolean
  list(opts: { cursor?: string; filter?: ListFilter }): AsyncIterable<DocMeta>;
                               // id, locator, version, title, updatedAt
  read(id: string): Promise<Doc>;                 // body (markdown or blocks), properties, version
  search(q: Query, opts: SearchOpts): Promise<Hit[]>;
                               // the app's own search; core adds semantic and graph search over indexed corpora
  changes(since?: Token): AsyncIterable<Change>;  // { kind: "upsert" | "delete" | "refused", id, version }
}
```

`changes()` is obsidian-tc's watcher shape. Corpora without push (Notion block edits, Apple Notes,
Google Docs) get a polling `changes()` from their base class that diffs `list()` versions; no
adapter writes its own poller.

### 4.2 Capability sets (each an optional interface the adapter may implement and must declare)

| set | operations | notes |
|---|---|---|
| `write` | `put(id, doc, { expectedVersion })`, `patch(id, edit, { expectedVersion })` | **compare-and-swap only**; the server refuses on mismatch (today's `prev_hash`). No last-write-wins anywhere |
| `blocks` | `readBlock`, `patchBlock` by block id | Logseq, Notion, Tana, Roam, Anytype |
| `links` | `outgoing(id)`; `backlinks(id)` only if declared | Notion, Joplin, Bear have no backlinks |
| `properties` | get/set frontmatter, database properties, tags | |
| `attachments` | list/read binary resources | |
| `snapshots` | native history, where the app has one | the server keeps its own snapshot-before-write regardless |
| `library` | `freshness`, `pacing`, `ingestPolicy`, `cluster`, `supportsIngest` | Alexandria's `SourceMeta`, unchanged |
| `app:<name>` | tool bundles loaded only when declared | Dataview, Templater, canvas, Excalidraw, Kanban, Bear x-callback, Logseq datalog |

### 4.3 Identity, versions, provenance

Every document is `{corpus, id, version}`: `id` is the app's own key (a path for files, a page id
for Notion, a block UUID for Logseq); `version` is the app's own concurrency token (content hash
today; `last_edited_time` for Notion; a CRDT revision for Anytype). Every hit carries
`{corpus, id, version, locator}`, where `locator` is the clickable form (`obsidian://`, a Notion
URL, a file path). Adapters must expose a stable, path-like `locator`, because the existing folder
ACL rules key on paths; ACL therefore ports unchanged and becomes locator-prefix ACL per corpus.

### 4.4 What stays in the server

ACL, HITL confirmation (`requireConfirmation`), snapshots-before-write, the index. The core indexes
any corpus that yields `changes()`.

### 4.5 Base classes, one per access model (from the note-app survey)

| base class | model | first users |
|---|---|---|
| `FileCorpus` | directory of files; fd-based reads, atomic writes, watcher (today's `notes-io`) | Obsidian, Logseq (file graphs), plain markdown folders, Zettlr/Typora/iA |
| `LocalDbCorpus` | read a local SQLite; write through an app hook | Bear (x-callback-url), Apple Notes (AppleScript; macOS only) |
| `LocalHttpCorpus` | localhost REST with a token | Joplin (41184), Anytype (31009), Obsidian Local REST API plugin (27124) |
| `RemoteCorpus` | OAuth, rate limiter, webhooks or polling | Notion (3 req/s, webhooks skip block edits, no full-text search), Craft (GraphQL), Capacities (REST 2.0), Reflect, Google Docs (batchUpdate, 3 req/s), Evernote |

Not adaptable today and recorded as such: Roam (no official API), Google Keep (enterprise-only API),
Tana reads (API new as of 2026-01, evaluate in sub-project 3). (Survey sources: developers.notion.com
request-limits and webhooks; joplinapp.org REST API; bear.app x-callback-url docs; Logseq db-version.md;
docs.craft.co; docs.capacities.io; developers.google.com/workspace/docs/api; che-apple-notes-mcp.)

### 4.6 Conformance kit

A shared test suite in `packages/corpus` run against any adapter: list/read round-trip; every hit
has valid provenance; `changes()` reports a write; compare-and-swap refuses a stale version;
undeclared capabilities are absent from the catalog. An adapter ships when the kit passes.

## 5. Migration sequence (one PR each, merged green, invariant stated)

| step | change | invariant |
|---|---|---|
| 1 | GitHub rename; LICENSE and every `license` field to MIT; README, SECURITY.md, docs header | `bun test` count unchanged; `publish.yml` still resolves its trusted publisher |
| 2 | `git mv` `packages/server/src/{db,search,embeddings,graph}` → `packages/core` (one commit per directory); server imports `workspace:*`; `release.mjs`, coherence checks and plugin mirror re-pointed with their tests | tool-catalog snapshot byte-identical; config schema unchanged; migration manifest untouched; `just map` diff explained |
| 3 | `packages/corpus` (contract, base classes, kit); `vault/`, `formats/` → `packages/corpus-obsidian` as `FileCorpus`; server keeps calling the same functions through a re-export layer | full server suite passes unmodified; kit passes on the fixture vault; catalog still byte-identical |
| 4 | filter-repo import of Alexandria into `packages/corpus-library`; tags prefixed; undici import ported; its tests run under both runtimes; its `bin` kept for the shim; **not** wired into the server | `eval:routing` reproduces nDCG@5 0.910 from the new path; history check passes |
| 5 | runtime lint; Node CI job with coverage; Bun job with compiled-binary smoke | both jobs green on the same commit |
| 6 | shims and listings (§6) | rehearsal tag published through the real workflow before `2.0.0` |

Step 2 precedes step 3 so the contract is designed against code that already compiles in its new
home; step 4 follows step 3 so Alexandria lands as a corpus family, not a second server.

## 6. Names, versions, release, old channels

- **New identities**: npm `@the-40-thieves/alexandria-tc` (server and shims), `@the-40-thieves/alexandria-tc-<package>` if an internal package is ever published; registry `io.github.The-40-Thieves/alexandria-tc`; `ghcr.io/the-40-thieves/alexandria-tc`; Homebrew `alexandria-tc.rb`; Smithery, Glama, Docker catalog, MCPB, gemini-extension and skills re-done under the new name. `corpus`, `core`, `corpus-obsidian`, `corpus-library` stay private `workspace:*` until someone outside needs one.
- **Version**: one lockstep version for everything published, starting at `2.0.0` (the rename is the breaking change). Alexandria's `11.x` ends at its shim.
- **Bootstrapping**: trusted publishing cannot create a package (npm/cli#8544, learned on Alexandria 11): each new npm name gets a manual placeholder publish from Cave, then the trusted publisher attached against `The-40-Thieves/alexandria-tc` / `publish.yml`. Whether the existing `obsidian-tc` binding survives the rename is research-claimed, not proven: a `2.0.0-rc.1` tag through the real workflow is the proof, before anything user-facing moves. Release signing stays on Cave.
- **Old channels, in order**: `2.0.0` cut → shims `obsidian-tc@1.32.0` and `@the-40-thieves/alexandria-mcp@11.1.0` (each depends on the new package, `bin` delegates and prints the rename once) → `npm deprecate` every version of both with the replacement named → new registry entry (the registry has no rename; old entries get a final version whose description points forward) → new Docker-catalog PR → old Homebrew formula `deprecate!` pointing at the new → Smithery re-listed → old `ghcr.io` image left at its last tag with the rename in its README → docs site moved (Pages does not redirect; the old URL gets a one-page pointer). The Obsidian community plugin keeps its id and release line.
- **Shims live one release cycle**, then their packages are deleted from the repo; the deprecation messages stay on npm.

## 7. Tests and gates

Every PR carries an invariant ledger (property + exact command), replayed on the committed head.

- **Kept, re-pointed**: the eight-gate lint job, tool-catalog parity snapshot, `just map`, version-coherence and bun-version checks, native eight-target build, perf-baseline artifact gate, three-platform test matrix; Alexandria's `eval:routing`, citation harness and weekly probe from `packages/corpus-library`. Each gets an **existence floor** (expected tool count, test count, source count) so a zero-item pass cannot masquerade as green.
- **New**: byte-identical `tools/list` and `resources/list` diff in CI; the runtime lint plus Node job (both jobs must be green on the same commit); the conformance kit on the Obsidian adapter; a history check after the import (`git log --follow` on ten sampled Alexandria files reaches pre-merge commits; every `alexandria-` tag resolves); the `2.0.0-rc.1` release rehearsal.
- **Review**: one in-pool review per PR; grok `verify-security` on the two security-relevant PRs (locator-keyed ACL in step 3, the undici port in step 4); one fix round per PR, residuals to a follow-up.
- **Not measured here**: cross-corpus retrieval quality and one-search latency (sub-project 2). The perf gate only has to show the obsidian-tc baseline unchanged.

## 8. Scope boundary and risks

**Out of scope, assigned**: wiring the library into the server and one search (sub-project 2); any
adapter beyond Obsidian (sub-project 3); docs site, listing copy, logo (sub-project 4); regrouping
the 161 tools by domain and publishing internal packages (later cleanups); the remote-first OAuth
work (THE-1110/THE-1111 stay on their epic; the foundation only keeps `auth.resource`,
`allowedHosts` and the JWT verifier where they are).

| risk | mitigation in this design |
|---|---|
| trusted-publisher binding after rename is unproven | `rc.1` rehearsal before any user-facing cut |
| undici port changes Alexandria fetch behaviour (cache interceptor, pinned connections) | 1,507 tests under both runtimes; routing eval reproduces 0.910 |
| history import is one-way once cloned | fresh clone, history check, push only after |
| vector search silently brute-force under `node:sqlite` | declared `vec0` flag in `describe()`, logged at open |
| release scripts reference package paths | step 2 touches them with their own tests before any cut |
| usage budget (six reviewed PRs) | 200-turn agent cap, one fix round, Codex and grok review lanes |

## 9. Done means

On `The-40-Thieves/alexandria-tc` at a tagged `2.0.0`: both CI jobs green; catalog diff empty;
conformance kit passing on the Obsidian adapter; Alexandria's eval reproduced from its new path;
both shims published and deprecated; registry and image listings live under the new name; an
existing obsidian-tc user who installs the shim gets the same tool surface plus a rename notice.

## 10. Open items the owner still holds

1. Confirm the lockstep `2.0.0` version (the alternative is an independent number for the library package).
2. The Obsidian community-plugin listing name: unchanged (`obsidian-tc`) or renamed in sub-project 4.
3. Whether to publish `corpus` as a public package early so third parties can write adapters before sub-project 3.
