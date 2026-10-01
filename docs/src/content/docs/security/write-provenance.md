---
title: Write provenance
description: A signed, hash-chained record of every committed mutating tool call, what each field is trusted for, how to verify the chain, and how to query one note's history.
---

Every mutating tool call that commits writes one **provenance record** to `cache.db`. A record
says which tool ran against which vault, which paths the call named and what their bytes hashed to
before and after, when, and who the server believes called. Records are chained per vault and
signed with the auth registry's EdDSA key, so a record that is later edited, reordered or removed
fails `obsidian-tc provenance verify`.

Records hold **hashes and attribution only**: never note content, never prompts. They are written
by the dispatch pipeline itself (one choke point for every mutating tool, derived from the tool
registry, so a new mutating tool is covered by construction). Recording is **fail-open**: a fault
in the recorder never fails or blocks the write it describes. A fault is not silent, though: see
[Recording faults](#recording-faults).

## What is trusted

Every attribution field sits in exactly one of three groups, so a reader never has to guess.

| Group | Fields | Trust |
|---|---|---|
| `verified` | `host`, `server_version`, `transport`; `principal` and `persona` **only when a bearer token was cryptographically verified** (`auth.mode: jwt` or `oidc`); `session_id` | Established by the server. A client cannot influence them. |
| `unauthenticated` | `principal` label seen on stdio or under `auth.mode: none` | The server saw a label; nobody proved it. Kept apart from `verified` so it cannot pass for it. |
| `self_reported` | MCP `clientInfo` name and version; the request `_meta` block `io.obsidian-tc/provenance` with `model`, `project`, `agent`, `machine` | **Whatever the client said.** A client can lie about its model, project, agent or machine; nothing here is checked. |

A client names itself in the request `_meta`:

```json
{ "_meta": { "io.obsidian-tc/provenance": { "model": "claude-sonnet-5-5", "project": "notes-sync" } } }
```

Values are strings only and length-bounded; an oversized or non-string value is dropped rather than
truncated. Treat `self_reported` as a label for humans and audit triage, never as an access
decision.

What a record does **not** claim:

- **Paths are the paths the call named.** Side effects the tool performs elsewhere, such as backlink
  rewrites in other notes, are not listed.
- **Digests** are a sha256 of the file's bytes, or `absent` (no file there) or `unhashable`
  (directory, symlink, unreadable, or over the size cap). A symlink pointing outside the vault is
  never followed: it records `unhashable`. Beyond 500 paths per call the rest are counted in
  `paths_omitted`, not listed.
- **The `after` digest is bound to the write where the tool reports it.** Tools that rewrite one
  note (`write_note`, `append_note`, `patch_note`, `update_frontmatter`, the tag tools) return the
  sha256 of the content they wrote, and that value is recorded, not a later read of the disk. For
  every other tool the file is hashed after the handler returns, and the opened file descriptor is
  checked to be the very file the vault-containment check vetted (same device and inode, with the
  path re-resolved after the open), so a directory swapped for an outside symlink in that window
  records `unhashable` instead of the outside file's hash. **Residual:** for those other tools
  (move, copy, delete, bulk and structured-document tools) a writer that replaces the file inside
  the vault between the handler returning and the digest being taken would have its bytes recorded
  as that call's `after`. The attribution is still the caller's; the digest is then "what the file
  held just after the call".
- **Failed and denied calls are not recorded.** The exception is a call that threw after a named
  path had already changed: it is recorded with `outcome: "error"`.

## Signing

A record is signed with the auth registry's **active EdDSA key**. The registry exists for
`auth.mode: jwt` / `oidc` servers on the HTTP transport; create the key with:

```bash
obsidian-tc auth rotate-key --alg EdDSA
```

Records written without such a key are stored **unsigned**. That is the case for a **stdio-only
deployment, which has no registry and is therefore chain-only**: the hash chain still catches a
single edited or removed record, but anyone who can write `cache.db` could rewrite the whole chain
and re-hash it. An HS256 or ES256 active key is never used for provenance (HS256 is a shared secret:
anyone able to verify could forge), so those deployments are also unsigned.

Key rotation does not orphan history: verification accepts every registry key in any state, so a
record signed by a since-retired key still verifies for as long as it is kept.

A signed **head row** per vault pins the last record's sequence number and hash. Without it a
removed *last* record would leave a perfectly valid shorter chain; with it, removal is a
`head_mismatch`.

### The head is validated before it is extended

The head is what makes a deleted prefix or tail detectable, so the server never trusts a head it
finds on disk. Before a new record extends it, and before retention re-anchors it, the head must
pass four checks: it exists whenever records do; it pins the real last record (or its own prune
anchor when none remain); its prune anchor equals the first surviving record's `prev` and sequence;
and its signature, if it had one, still verifies under a registry key (any state). Only a head that
passes is re-signed.

If it fails, the server does **not** re-sign it and does **not** overwrite it. The write is still
recorded, chained from the real last record and stamped with `integrity.head_fault` naming the
failed check, so `provenance verify` reports `head_untrusted` for it (never hidden by
`--allow-unsigned`) on top of the bad head itself. The failure is also logged to stderr, counted in
`obsidian_tc_provenance_faults_total{kind="head_untrusted"}`, and fails the doctor check. Retention
skips a vault whose head fails validation and logs why. The chain then stays failed until the
operator restores `cache.db` from a trusted backup or archives it: re-baselining it silently would
be exactly the laundering this prevents. A signer outage over a signed head records nothing for
that write (counted as `omitted`) instead of writing an unsigned head over a signed one.

**What a writer of `cache.db` without the signing key can and cannot do.** It can delete or edit
rows, forge `pruned_*` or `head_*`, and strip signatures; every one of those fails verification and
is no longer papered over by the next write. It cannot produce a head that verifies, because the
head signature covers every head field. It can still delete **everything** (all records and the
head row) and restart the chain at seq 1: with no external anchor that is indistinguishable from a
vault that was never written to. It can also hide a stripped, unsigned chain from `--allow-unsigned`
(see above), and a deployment with no EdDSA key is chain-only and can be rewritten wholesale. If
the auth registry database is lost, an old signed head names a key nobody holds, so the chain reports
`head_unknown_kid` and new records are stamped `head_untrusted` until the registry is restored.

## Verifying

```bash
obsidian-tc provenance verify                      # every vault with a chain
obsidian-tc provenance verify --vault notes --json
obsidian-tc provenance verify --allow-unsigned
```

The command is read-only, opens `cache.db` and the registry read-only, and exits **1** when any
chain fails. For each vault it prints the record count, how many are signed and unsigned, and every
problem (`hash_mismatch`, `seq_gap`, `chain_break`, `head_mismatch`, `head_untrusted`, `unknown_kid`, `bad_signature`,
and the head variants). If the auth registry was initialised but `<cacheDir>/auth.db` is lost, it refuses and
says so: with no keys every signature would read as tampered when the truth is that nothing can be
checked.

**`--allow-unsigned`** accepts records that carry no signature. Without it an unsigned record is a
**failure**, deliberately: if unsigned were acceptable, an attacker could strip every signature and
rewrite the chain. Pass the flag for stdio-only or pre-EdDSA deployments where chain-only integrity
is what you have; a record that *has* a signature is always checked, flag or not.

`obsidian-tc doctor` runs the same verification as the **provenance chain** check: it fails on any
sign of tampering, warns when records exist without signatures, the chain cannot be read, or a
recording fault is on file, and notes (without warning) a fresh install that has no EdDSA key yet.

## Querying one note's history

`get_provenance` answers "who changed this note, and when" for a single path:

```json
{ "vault": "notes", "path": "projects/plan.md", "limit": 20, "include_verification": true }
```

Records come back **newest first** (by sequence number). `limit` is 1 to 200 (default 50); when more
remain, `next_cursor` is the sequence number to pass as `cursor` for the next page. `since` and
`until` are epoch milliseconds, inclusive. Each record has the tool, `outcome`, `ts`, the sha256
`before` and `after` of the queried path, `seq`, the record `hash`, every readable path the call
named, and the attribution in the same three groups as the stored record. They are returned
**separately and never merged**: `verified` is what the server established, `unauthenticated` is a
label the server saw and nobody proved, and `self_reported` is what the client said about itself
(`model`, `project`, `agent`, `machine`, `client`) and can be false. Decide nothing from
`self_reported`. `response_format: "concise"` keeps the grouped attribution (without `host`,
`server_version`, `transport` and `machine`) and drops the full path list and the record hash.

**Who may call it.** The tool requires `read:provenance` **in addition to** `read:notes`. A record
names the principal and session of whoever wrote, which is audit data and not part of being allowed
to read a note, so it is its own grant (`read:*` and `*` include it, as for any scope). Anyone who
holds it sees the principal, persona and session of **other** principals for the paths they can read;
there is no finer per-principal gate.

**Access control.** The query uses the same read check as search and the link tools, against the ACL
of the vault being queried:

- A path the caller cannot read answers with the same `not_found` error, with the same message and
  details, as a path that was never written. The tool declares no central path check on purpose: that
  would answer `acl_denied`, which says the note exists. With `since`, `until` or `cursor`, both give
  an empty page.
- A record that names several paths (a move, a copy, a bulk call) lists **only the paths the caller
  can read**. A path they cannot read is left out with no placeholder and no count, and a record
  keeps only its readable entries.
- A vault's records and its ACL never serve another vault.

**Moves.** A record lists a move as a `[from, to]` pair. When the newest `move_note`,
`bulk_move_notes` or `move_attachment` record moved a file onto the queried path, the history of
the source path is part of the result (`previous_paths`, and each record's `path` says which path it
matched), and the walk repeats for that source, up to 32 moves. The walk stops at a source the
caller cannot read, so it never learns the source existed. Records from before the file arrived at a
path (a previous occupant it overwrote) are not part of its history. Moves are **not** followed
forwards: the old path shows its history up to the move, not what became of the file. Renames done by
other means (a tool that only deletes and creates) are plain writes, so they are not linked.

**Verification.** With `include_verification`, each record carries `verification`:
`signature` is `valid`, `invalid`, `unknown_key`, `unsigned`, or `unverifiable` (no key registry,
for instance a stdio-only deployment, or an unreadable one: signatures cannot be checked, which is
not evidence of tampering); `chain_link` is `ok` or `broken`; `problems` lists the codes
`provenance verify` uses; `ok` is true only for a valid signature with no problem. This reuses the
verifier's own per-record check, so the two cannot disagree about one record. It does **not** prove
the chain is complete: a removed later record or a forged head is only visible to
`obsidian-tc provenance verify`. The query reads `cache.db`, as `verify` does, so a writer of that
file can forge records but not signatures (see the limits above).

**Limits.** A record stores the paths the call named, up to 500 per call (see `paths_omitted`): a
note beyond that cap in a bulk call has no record that names it. The records have no path index, so
a query scans the vault's chain with a text prefilter on the file name; a deployment that keeps its
whole history (`retentionDays` unset) and writes a lot pays for that in latency, and `retentionDays` bounds
it.

## Recording faults

Because recording is fail-open, a committed write whose record could not be stored (a dropped
table, a sequence collision, a signer outage over a signed head) would otherwise look like "no
write happened", and the chain would still verify. Each such fault is therefore made visible three
ways: a `[provenance]` line on stderr, the `obsidian_tc_provenance_faults_total` counter (labels
`vault`, `tool`, `kind` of `omitted` or `head_untrusted`), and a `provenance_fault` row in
`event_log`, which is what `obsidian-tc doctor` (a separate process) reads to warn "N committed
writes left no record". The doctor warning ages out with `event_log` retention; the counter resets
with the process. The write itself is never failed.

## Optional stamps

The record in `cache.db` is the source of truth. Two **optional** stamps copy a little of it to
where a human will see it. Both are **off by default**; with them off, every note and every commit
message is byte for byte what the caller sent. Neither stamp holds anything the record does not
already hold, and neither ever contains the host id. Both need `provenance.enabled`.

### Commit trailers

`provenance.stamp.gitTrailers: true` makes the `git_commit` tool append trailers to the message it
sends to the Git bridge:

```text
snapshot

Obsidian-TC-Session: 7f3c0e
Obsidian-TC-Principal: alice
Obsidian-TC-Model: claude-sonnet-5-5 (self-reported)
Obsidian-TC-Provenance-Seq: notes:41-44
```

- **Trust is in the text.** `Obsidian-TC-Principal` is the principal a bearer token proved
  (`auth.mode: jwt` or `oidc`), or the word `unverified` (stdio, `auth.mode: none`). The model is a
  client's own claim and is always followed by `(self-reported)`. A value is one line: control
  characters, including a newline in a claimed model, are replaced by a space, so a client cannot
  end its own trailer and start another.
- **Which writes.** The server asks the bridge what is staged, then keeps each staged note whose
  bytes *right now* equal what a record says that write left (`after`). A note a human edited since
  is not attributed to the agent, a deletion is not attributed at all, and a path no record names is
  ignored. A repo that sits above the vault (`Vault/a.md` in Git, `a.md` in the vault) still
  matches. Only the newest 2000 records of the vault are searched. A commit that includes no
  recorded write gets **no trailers**, and so does a commit whose staged list could not be read:
  the commit itself is never failed or delayed by stamping.
- **`Obsidian-TC-Provenance-Seq: <vault>:<from>-<to>`** bounds the matching records. Other records
  can sit between the two numbers (a write to a note that is not in this commit); the range says
  where to look, the digests say which.
- **One value per writer.** If the commit holds writes from several sessions, principals or models,
  each distinct value gets its own trailer line (at most 10 of a kind; more adds
  `Obsidian-TC-Truncated`).
- **Your message is kept.** Trailers go at the end, after a blank line, or into the message's
  existing trailer block (`Signed-off-by: ...`) the way `git interpret-trailers` would. The one
  exception: an `Obsidian-TC-*` trailer **you wrote** in the final trailer block is removed when
  this stamp is on, so that a trailer under the prefix is always the server's. The server does not
  run `git` on the vault to do any of this.
- The tool result gains `stamped_trailers` (the lines that were added) when there were any.

**What a trailer does not prove.** Trailers live in the commit message, which anyone who can
rewrite history can change; the signed chain is what proves the record. The session id is the
server's own, but the model is only what the client said.

### Frontmatter stamp

`provenance.stamp.frontmatter: true` writes one key into a note an agent **creates**:

```yaml
obsidian_tc_provenance:
  session: 7f3c0e
  principal: alice
  model_self_reported: claude-sonnet-5-5
  seq: 41
```

- **Creations only:** `write_note` when the note did not exist (`create`, or `upsert` of a new
  note), `commit_capture`, and `execute_template` when the target did not exist before the call.
  `write_note` over an existing note, `append_note` (including `create_if_missing`), `patch_note`,
  `update_frontmatter`, `execute_template` with `overwrite` and every other tool never stamp.
- **Human frontmatter is never modified.** The key is added with the vault's own line-preserving
  frontmatter writer, so every other key, comment and scalar keeps its exact source bytes. A note
  whose frontmatter is not valid YAML is written unstamped. The one thing replaced is a value the
  *caller* put under the stamp key in a note it is creating, so a forged stamp cannot pass as the
  server's.
- **Fields:** `session` (when the call had one), `principal` (verified, else `unverified`),
  `model_self_reported` (when the client claimed one) and `seq`. `seq` is where the write's own
  record is expected to land: one past the newest record of the vault when the note was written.
  It is exact when writes to a vault do not overlap and **never above** the real number otherwise;
  the authoritative link is the record whose path and `after` digest match the note.
- **Verification is unaffected.** The stamp is part of the bytes written, so the recorded `after`
  digest is the digest of the stamped note, and `provenance verify` passes exactly as before.
- **A stamp is a label, not proof.** Anyone who can edit the file can edit the stamp. Check a stamped
  note against the chain, not the other way round.
- `execute_template` stamps after Templater has written the note, so the note exists unstamped for
  an instant and a stamp failure leaves Templater's output as it was.

## Configuration

```json
{
  "provenance": {
    "enabled": true,
    "host": { "mode": "hashed" },
    "retentionDays": 365,
    "stamp": { "gitTrailers": false, "frontmatter": false, "frontmatterKey": "obsidian_tc_provenance" }
  }
}
```

- `enabled` defaults to `true`; `false` records nothing.
- `host.mode` is `"hashed"` (default, a stable digest of the machine's hostname) or `"label"`,
  which records `host.label` verbatim and requires it.
- `retentionDays` is absent by default, which keeps records forever.
- `stamp.gitTrailers` and `stamp.frontmatter` default to `false`; `stamp.frontmatterKey` names the
  key (letters, digits, `_` and `-`, up to 64 characters). Setting either stamp while `enabled` is
  `false` is a configuration error.

A hashed host id lets records correlate across restarts without naming the machine.

## Renaming a vault

The vault id is part of every signed record, so a vault rename does not re-key provenance: the old
chain stays under the old id and still verifies (`provenance verify --vault <old-id>`), and new
records start a new chain under the new id.

## Retention

`provenance.retentionDays` is **unset by default**: this is an audit trail and pruning it is an
explicit decision. When set, the maintenance sweep removes each vault's records older than the
window as one contiguous prefix and moves a **signed prune anchor** (in the head row) up to the last
record dropped. The surviving chain therefore still verifies. Removing any record that is not part
of the oldest prefix, or dropping a prefix without a matching signed anchor, still fails
verification. A sweep that has no signer available leaves a signed chain alone rather than
downgrading its head to unsigned. The sweep reports the count as `provenance`.
