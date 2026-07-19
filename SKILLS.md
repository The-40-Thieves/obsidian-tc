# obsidian-tc Agent Skills

A working guide for AI agents, and the people configuring them, to use the
**obsidian-tc** MCP server well. obsidian-tc gives an agent *governed* access to
one or more Obsidian vaults: **143 capabilities across 31 domains**, every call
funneled through one dispatch pipeline (auth, scopes, folder ACL, read-only kill
switch, idempotency, throttle, human-in-the-loop, response governor, audit).

Drop this file into your agent's instruction context (a `CLAUDE.md` / `AGENTS.md`,
a system prompt, or a skill) so the agent drives obsidian-tc from the real surface
instead of guessing tool names. The **Vault conventions** section (§8) is one real
vault's house style, shown as a template: keep what fits, replace the rest.

---

## 1. Mental model

**Governed access, not raw filesystem.** Every tool call, with no exceptions, runs
through one pipeline:

```
auth → scopes → folder ACL → read-only kill switch → idempotency
     → throttle → human-in-the-loop → handler → response governor → audit
```

You never have to remember to check permissions per call; the membrane does. An
agent that respects the pipeline cannot silently overwrite a year of notes, read a
folder it was denied, or fire a destructive op without a human tap.

**Two physical stores (the membrane).** Authored knowledge and disposable machine
signal never mix:

- **`cache.db`**, the durable index of your *authored* atoms (chunks, embeddings,
  FTS, the wikilink graph). Rebuildable from the vault files.
- **`experiential.db`**, quarantined machine telemetry (retrieval logs, work
  episodes, ACT-R activation). Disposable. Never surfaced as if it were a note.

**Local-first, no egress by default.** The default embedder is local Ollama; the
generative tier is off unless you wire a local inference gateway; derived graph
edges are never written back into your notes. Nothing leaves the machine unless you
configure a cloud provider or gateway.

**Live vs headless.** With the companion plugin's Local REST API reachable, the
vault runs *live* and bridge tools work (Bases, Canvas render, OCR, Templater, Git,
Remotely Save). Without it, the vault is *headless*: every filesystem tool still
works; bridge tools return `requires_live_obsidian`. Mode is resolved **once at
startup**.

---

## 2. Setup (new users)

**Install** (Node ≥ 24 or Bun ≥ 1.1; also ships as a Docker image, a one-click
`.mcpb` bundle, and standalone binaries):

```bash
npm install -g obsidian-tc
```

**Zero-config start.** Point it at a vault folder and it boots a single vault with
id `main` and every default:

```bash
obsidian-tc serve /absolute/path/to/vault
```

**Real config** is one JSON file (path as argv, or `OBSIDIAN_TC_CONFIG`). The
minimum is a vault list; every other block is fully defaulted:

```json
{ "vaults": [{ "id": "main", "path": "/absolute/path/to/vault" }] }
```

Inspect and validate before wiring it up:

```bash
obsidian-tc config validate ./config.json
obsidian-tc config show ./config.json   # secrets redacted
```

**Turn on live mode (recommended)** so bridge tools work: install the companion
plugin, enable the Local REST API's **non-encrypted loopback** server
(`http://127.0.0.1:27123`), and add its key to the vault entry:

```json
{ "vaults": [{
  "id": "main",
  "path": "/absolute/path/to/vault",
  "restApiUrl": "http://127.0.0.1:27123",
  "restApiKey": "<Local REST API key>"
}] }
```

The bridge client does not trust LRA's self-signed HTTPS, so use the loopback HTTP
port. `obsidian-tc plugin install` copies the companion plugin into your vault.

**Wire into your AI.** Register obsidian-tc as an MCP server in your client
(Claude Desktop / Claude Code / any MCP host). Default transport is **stdio** (the
trusted local path). For many-client or remote use, enable Streamable HTTP under
`transports.http`, and note the fail-closed interlock: an unauthenticated server
(`auth.mode: "none"`) refuses to bind a non-loopback host. Put a JWT on anything
routable.

**First index.** On first serve the vault indexes automatically; you can force a
rebuild with the `index_vault` capability or the CLI. Changing the embedding
model/dimensions or `cacheDir` needs a fresh cache (see §9, dimension-lock).

**Verify.** Call `find_capability` with a plain-English need (below). If it returns
matches, you are wired up.

---

## 3. The core skill: discover, don't guess

By default the server advertises **three meta-tools**, not a wall of 143. This
keeps agent context lean. Learn this loop before anything else:

1. **`find_capability`**, BM25 search over the capabilities *this caller can see*.
   Ask in plain language: `"move a note to another folder"`, `"render a canvas"`,
   `"what did we decide about auth"`.
2. **`describe_capability`**, the chosen capability's input schema, required
   scopes, and safety hints. Read this before calling anything unfamiliar.
3. **`call_capability`**, invoke it by name with validated arguments. The call
   routes through the exact same auth/scope/ACL/HITL/idempotency/throttle pipeline
   as a direct call; the target's own schema validates the args.

Every capability also remains **directly callable by name**. `toolFacade.mode`
selects what `tools/list` shows: `triad` (default, 3 tools), `domain` (~a dozen
domain meta-tools like `notes`, `search`, `vault`), or `flat` (the whole surface).
The facade is boundary-only: no gate is bypassed in any mode.

> Rule for agents: when you need an operation you have not used before, run
> `find_capability` then `describe_capability`. Do not invent a tool name.

---

## 4. Capability map (by intent)

Use `find_capability` for exact names; this is the terrain, grouped by what you
want to do. Counts are approximate; the surface is 143 tools / 31 domains.

| You want to… | Reach for | Notes |
| --- | --- | --- |
| **Read / write notes** | read, write, append, patch, move, delete a note; frontmatter get/set; tags; links | Writes obey folder ACL + HITL + optional CAS. Delete is HITL-gated. |
| **Search the vault** | full-text (FTS5 BM25), semantic (vec0 kNN), hybrid, `find_notes_by_*` | Hybrid fuses lexical + dense via RRF. |
| **Multi-hop / GraphRAG** | `vault_graph_search` | Walks the wikilink graph, RRF-fuses seed + expansion + lexical streams. |
| **One-call context for a question** | `vault_context` (`get_context(query, token_budget)`) | Budget-packed graph-reranked chunks + synthesis patterns + open contradictions + proactive lessons. The single best entry point for "answer from my vault." |
| **Grounded synthesis** | `reflect` | Synthesis with source provenance, an adversarial challenge mode, a versioned preference profile. Needs the inference gateway. |
| **Red-team a claim** | `knowledge_challenge` | Retrieves decision notes to argue against a proposal. |
| **Search vendor / external docs** | `knowledge_search` (docs corpus) | The docs-scoped analogue of `vault_graph_search`, bound to a reserved read-only docs vault. Gated on `read:docs`; no reranker (THE-441). |
| **Critical docs to read first** | `knowledge_get_critical` | Frontmatter `severity == critical` pre-filter: breaking changes / security / production gotchas, optionally per source. |
| **Structured formats** | Bases (`.base` DSL evaluator), Canvas, Kanban, Periodic notes, Tasks, Excalidraw, Bookmarks, Workspaces | Several need live mode (render/DSL). |
| **Attachments / OCR** | attachment tools, OCR route | OCR needs live mode + the plugin. |
| **Memory graph** | memory entities + `[[link]]` graph, workspace sessions + JSONL traces | Projections live in the `memory/` folder. |
| **Work-memory (experiential)** | retrieval-log readers, episode readers, `forget` | Quarantined store; eligible-only reads; see §5. |
| **Bulk / admin / URI** | bulk ops, `add_vault`, `reload_vault`, `reset_vault_cache`, `index_vault`, snapshots/`restore_note`, `session_bootstrap`, resources over `obsidian-tc://<vault>/<path>` | Bulk + admin are throttled hardest. |
| **Companion bridges** | Obsidian Git (status/diff/log/stage; commits behind a hard human-confirmation floor), Remotely Save (backup verification), Templater/execute | Live mode only. |
| **Run a vault command** | `execute_command` | Deny-by-default: needs `commands.enabled` + an allowlist entry, and is still HITL-gated. |

---

## 5. New and notable (what is genuinely different here)

These are the skills that set obsidian-tc apart. Teach your agent to prefer them.

**Measured retrieval, not asserted.** Every ranking change is gated by an n=136
multi-hop golden set with a statistical ship rule (paired permutation, BH-FDR,
a ΔnDCG ≥ 0.010 cost gate). The live champion: graph nDCG@10 **0.786**, recall@10
**0.871**, bridge recall **0.831**. Contextual chunk enrichment measured **+0.223
nDCG** and defaults on. The practical takeaway for an agent: **trust the default
retrieval**, it is the measured optimum for this vault, and experimental streams
that did not beat it ship *dark* behind flags (see below).

**`vault_context`, the one-call context primitive.** Instead of hand-orchestrating
search + graph + rerank, call `get_context(query, token_budget)` and get a
budget-packed, graph-reranked context bundle back. This is the highest-leverage
retrieval skill; reach for it first when answering from the vault.

**Quarantined experiential memory.** The server auto-captures its own work
(retrieval events + dispatch episodes) into `experiential.db`, physically separate
from your notes, with a pre-ingest secret/poison scanner and an outcome axis. By
default it records the *action* axis only (tool, status, sizes, hashes, **no
payloads**); `experiential.captureContent` opts into secret-scanned args. This is
the substrate for a knowledge flywheel (`metrics`, `gaps`, `activation-recompute`),
not something an agent reads as if it were authored content.

**`forget`, dependency-aware deletion.** Deleting a note propagates through derived
state, with tombstone-vs-erase modes and a **hash-chained audit log** where
tampering with any entry breaks verification. Use it instead of a raw delete when
provenance matters.

**Governance an agent can rely on.** Folder ACLs (per vault, per caller), a
read-only kill switch, HITL elicit on destructive ops, compare-and-swap on writes
(`writes.requireCas`), idempotency keys, a response-size governor, and a
ReDoS-bounded regex. These are not optional add-ons; they are the dispatch path.

**Snapshots + restore.** With `snapshots.enabled`, destructive writes capture prior
state (content-addressed) so `restore_note` can roll back a bad edit.

**Dark-by-default measured features.** Graph densification (`retrieval.densify.*`),
learned-sparse and ColBERT serve streams (`retrieval.sparse` / `retrieval.colbert`),
the class router (`retrieval.classRouter`), the polyglot model tier
(`embeddings.provider: "model-tier"`), and the ACT-R activation rerank
(`experiential.activationRerank`) all ship **off**, each pending an A/B on your
golden set. An agent should not flip these expecting a win; they are opt-in
experiments, not tuned defaults.

**The generative tier is opt-in and local.** `reflect` synthesis, `densify-llm`
edge building, and ambient `plane` consolidation only run when you set
`OBSIDIAN_TC_GATEWAY_URL` to a local inference gateway. No LLM calls happen
otherwise.

---

## 6. Operating safely (agent rules)

- **Discover before calling.** `find_capability` → `describe_capability` → call.
- **Expect HITL on destructive ops.** Delete, some bridge writes, and `execute_command`
  return an elicit request; surface it to the human and wait for the single-use,
  args-bound confirmation. Do not try to route around it.
- **Respect the ACL result.** A `forbidden` / `acl_denied` / `read_only_mode` is a
  decision, not a transient error to retry. Report it.
- **Use CAS on overwrites when it matters.** Pass `prev_hash` to `write_note` /
  `append_note` (required when `writes.requireCas` is on) so you never clobber a
  note that changed under you.
- **Use idempotency keys for retriable writes/bulk.** A keyed call that already
  committed replays its result on retry instead of running twice.
- **Page, do not raise the ceiling.** Responses over `governor.maxResponseBytes`
  are rejected; use cursors/limits rather than asking for a bigger budget.
- **Name the vault.** Multi-vault calls take `vault: "<id>"`; HTTP tokens are bound
  to a vault and reject a call that names another.
- **Config changes need a restart.** The server reads config at boot and resolves
  live/headless once; `reload_vault` only re-validates. Restart the server (or your
  MCP client) to apply changes.

---

## 7. Agent playbooks (recipes)

**Answer a question from the vault**
1. `vault_context` with the question and a token budget → grounded bundle.
2. If it is a "how do these connect" question, prefer `vault_graph_search`.
3. Cite note paths; never present `experiential.db` signal as authored content.

**Write knowledge back**
1. Pick the destination folder by content (§8 routing).
2. Compose the note with correct frontmatter + wikilinks to related notes (no
   orphans).
3. `write_note` (or `append_note` for logs/handoffs). Pass `prev_hash` if updating.
4. If it records an architectural decision, write a decision note (§8), the
   substrate the `knowledge_challenge` red-teamer later retrieves.

**Do a destructive edit safely**
1. `describe_capability` to confirm scopes + that it is HITL-gated.
2. Call it; relay the elicit request to the human; wait for confirmation.
3. Prefer `forget` over raw delete when the note has derived state.

**Onboard a new vault**
1. `add_vault` (or add it to config + restart).
2. `index_vault` to build the index.
3. Set an ACL: `readPaths` / `writePaths` / `deletePaths`, and
   `strictReadDefault: true` if the agent should fail closed on unlisted reads.

**Close a session (write-back)**
1. Append open threads to the handoff note (`memory.folder`/`_next-session.md`).
2. Write any decisions as decision notes.
3. Leave the vault, not the chat, as the durable record.

---

## 8. Vault conventions (a synthetic example, adapt to yours)

This is a synthetic example convention set, not any real vault, following a
numbered-folder (PARA-style) taxonomy with generic placeholder categories. It is a
reasonable default; change the categories and fields to match yours. The point is
**consistency**: a vault only compounds if every write lands in the right place
with the right metadata.

**Folder routing**

| Folder | For | Filename |
| --- | --- | --- |
| `00-inbox/` | raw captures awaiting routing | `YYYY-MM-DD-topic.md` |
| `01-daily/` | daily log (append only) | `YYYY-MM-DD.md` |
| `02-projects/` | active projects, one per project | `kebab-case.md` |
| `03-areas/` | ongoing areas of responsibility (ACL-restrict any sensitive ones) | free-form |
| `04-writing/` | drafts and published pieces | `slug.md` |
| `05-resources/<topic>/` | reference material by topic | `Title Case.md` |
| `06-media/` | media project notes | per subtype |
| `07-people/` | one note per person | `First Last.md` |
| `08-research/<domain>/` | structured research | `Title Case.md` |
| `09-reference/` | evergreen protocols, registries, indexes | `Title Case.md` |
| `09-reference/decisions/` | **decision notes (immutable)** | `YYYY-MM-DD-decision-slug.md` |

**Frontmatter on every note.** ISO dates (`YYYY-MM-DD`), kebab-case tags, a `type`.
Minimum:

```yaml
---
created: 2026-07-15
updated: 2026-07-15
type: project | reference | decision | research | person | daily
tags: []
---
```

**Obsidian Flavored Markdown.** Wikilinks `[[Note Name]]` (never raw paths in
prose), `[[Note#Heading]]`, `[[Note|Alias]]`; callouts (`> [!note]`, `> [!warning]`);
task lists (`- [ ]`, `- [x]`, `- [/]`, `- [-]`); embeds `![[Note]]` / `![[img.png|300]]`.

**No em dashes anywhere in notes.** Use a comma, colon, or parentheses. Em dashes
silently break Mermaid node labels and read as machine-generated.

**Decision notes are mandatory** for any architectural choice, vendor/tool pick,
"we tried X and chose Y", or hard veto. One immutable note per decision in
`09-reference/decisions/` with: the decision (one line), context, alternatives,
rationale, implications, reversibility/kill-switch, and wikilinks to related notes.
These are what the red-teamer retrieves; a decision made without a note silently
degrades future review.

**No orphans.** Every new note links from at least one existing note. **One topic
per note**; split at ~500 lines. **Append, do not multiply** daily/handoff notes.

**Session write-back.** At session end, route new knowledge to the right folder,
write decisions as decision notes, and append open threads to the handoff note.
The vault is the layer that survives; the chat is not.

---

## 9. Config quick reference + gotchas

The complete option surface (every field, default, env var, and CLI command) is in
`docs/src/content/docs/configuration/config-yaml.md`. The knobs you touch most:

| Knob | Default | Why you would change it |
| --- | --- | --- |
| `vaults[].path` / `id` | - | Required: where the vault is, how tools name it. |
| `vaults[].restApiUrl` + `restApiKey` | - | Turn on live mode (bridges). |
| `embeddings.provider` / `model` / `dimensions` | `ollama` / `nomic-embed-text` / 768 | Swap the embedder. **Dimension-locked**: changing it needs a fresh `cacheDir`. |
| `acl.readPaths` / `writePaths` / `deletePaths` | read `**`, write `02-projects/**` | Scope what the agent may touch. |
| `acl.strictReadDefault` | false | Fail closed on unlisted reads. |
| `acl.readOnly` | false | The kill switch. |
| `writes.requireCas` | false | Force `prev_hash` on overwrite/append. |
| `auth.mode` | `none` | `jwt` for anything non-loopback (required by the interlock). |
| `toolFacade.mode` | `triad` | `flat` if your client prefers the full list. |
| `transports.http.enabled` | false | Many-client / remote (then set auth). |
| `experiential.captureContent` | false | Opt into storing (scanned) call args. |
| `OBSIDIAN_TC_GATEWAY_URL` (env) | unset | Enable the generative tier (`reflect`, `densify-llm`, `plane`). |

**Gotchas that bite new users**

- **Runs on Bun** (`bun:sqlite`): the shipped `dist/cli.js` boots under Bun; plain
  `node dist/cli.js` fails on the `bun:` import. Use the global bin or Bun.
- **Config resolves at boot.** Restart the server/client to apply changes;
  `reload_vault` only re-validates. Adding/removing a vault always needs a restart;
  changing `path` / embeddings / `cacheDir` also needs `reset_vault_cache` or a
  fresh cache.
- **Live vs headless is resolved once** at startup. If the plugin was not reachable
  when the server started, bridge tools stay `requires_live_obsidian` until you
  restart with it up.
- **`.obsidian/`, `.git/`, `.trash/` are always denied** (case-folded). Do not try
  to read or write plugin config or git internals through the vault tools.
- **Dark features are dark on purpose.** Do not flip `retrieval.*` /
  `experiential.activationRerank` / the model tier expecting a win; they are
  unmeasured on your vault. Run the eval first.
- **Secrets** (`restApiKey`, embedding/gateway keys, JWT secret) resolve
  config-then-env and never appear in logs, errors, or audit rows. Prefer the env
  vars.

---

*Generated as agent-onboarding guidance for obsidian-tc. The capability surface is
authoritative via `find_capability` / `describe_capability`; when this file and the
live schema disagree, trust the schema.*
