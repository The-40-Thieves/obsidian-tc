# Why obsidian-tc — the threat model in one page

## The problem: agents plus vaults

An Obsidian vault is often the most sensitive plain-text corpus a person owns: journals,
credentials pasted into notes, plugin API keys under `.obsidian/`, drafts never meant to
leave the machine. An autonomous agent with raw vault access combines three failure
modes:

- **Destruction.** One wrong tool call overwrites or deletes notes; a bulk operation
  multiplies the blast radius.
- **Exfiltration.** An agent that can read everything will happily retrieve everything —
  including folders you would never have handed it deliberately.
- **Manipulation.** Vault content itself is untrusted input: a note an agent retrieves
  can carry instructions that steer its next actions (see the prompt-injection section
  of [SECURITY.md](../SECURITY.md)).

obsidian-tc's position: agents are **partially trusted**. Useful, worth giving real
capabilities, and never given ungoverned authority.

## What governance means here, concretely

Every tool call — all 146 capabilities, whether called by name or through the
`call_capability` facade — passes one dispatch pipeline. Nothing is enforced by prompt
or convention; each gate is server-side code:

- **Scopes.** JWT-authenticated callers hold explicit scope grants (`read:notes`,
  `write:notes`, `delete:notes`, …); a tool's required scopes are checked before it
  runs. HS256 shared-secret or asymmetric RS256/ES256/EdDSA via a local JWKS, with
  `kid`-based key rotation. HTTP tokens can be bound to a single vault.
- **Folder ACL — per vault.** Glob whitelists for read, write, and delete paths, plus
  a read-only kill switch. Each vault can carry its own `acl` block (the root block is
  the inherited default), so "write vault A, read-only vault B" works in one process.
  `.obsidian/**`, `.git/**`, and `.trash/**` are hard-denied regardless of
  configuration, and ACL checks run against the symlink-canonicalized,
  Unicode-normalized path — not the string the caller typed.
- **HITL (human-in-the-loop).** Destructive operations fail closed with
  `elicit_required`. Proceeding needs a single-use elicit token bound to the exact
  vault, tool, and argument hash, with a 5-minute TTL. Agents cannot mint tokens;
  humans grant them per call.
- **CAS (compare-and-swap).** Writes accept a `prev_hash`: if the note (or bookmark /
  workspace file) changed underneath the caller, the write fails with
  `concurrent_modification` instead of clobbering. Idempotency keys make retried
  writes safe.
- **Audit.** Every invocation lands in the audit log, with optional OpenTelemetry
  traces, Prometheus metrics, and CloudEvents emission (ACL denials, elicit requests,
  rate-limit hits are distinct events).

Plus rate limiting by operation tier (read / write / delete / bulk / execute / admin), a response-byte governor,
compute budgets (regex worker timeouts, JSONLogic op caps), and path-traversal
containment with real-path symlink checks.

## What obsidian-tc deliberately is NOT

- **Not a cloud service.** It runs on your machine against your files. The default
  stack is fully local: Ollama embeddings, SQLite cache, bundled `sqlite-vec`. Cloud
  embedding providers and the inference gateway are opt-in config.
- **No telemetry by default.** The observability streams exist for *you*: OTel is a
  no-op until you set an endpoint, the Prometheus endpoint is disabled until enabled,
  and CloudEvents spool to a local JSONL file unless you configure an HTTP push.
  Nothing phones home.
- **Not an Obsidian plugin replacement.** obsidian-tc is a standalone MCP server for
  agents and MCP clients. The optional companion plugin only bridges plugin-specific
  features (Templater, Dataview, Tasks, …); the core server works with Obsidian closed.
- **Not a defense against a hostile operator or host.** The host system and the
  Local REST API key are trusted (the LRA key is a full-vault admin credential — see
  [SECURITY.md](../SECURITY.md)). The gates govern agents talking MCP, not root on
  your box.

If you just want a thin, single-user read/write wrapper, simpler servers exist and are
listed honestly in the [README comparison](../README.md#how-it-compares). obsidian-tc is
for the moment you let software you don't fully trust work inside notes you care about.
