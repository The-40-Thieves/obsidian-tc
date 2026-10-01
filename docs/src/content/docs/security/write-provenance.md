---
title: Write provenance
description: A signed, hash-chained record of every committed mutating tool call, what each field is trusted for, and how to verify the chain.
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
the registry (`auth.db`) is lost, an old signed head names a key nobody holds, so the chain reports
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

## Recording faults

Because recording is fail-open, a committed write whose record could not be stored (a dropped
table, a sequence collision, a signer outage over a signed head) would otherwise look like "no
write happened", and the chain would still verify. Each such fault is therefore made visible three
ways: a `[provenance]` line on stderr, the `obsidian_tc_provenance_faults_total` counter (labels
`vault`, `tool`, `kind` of `omitted` or `head_untrusted`), and a `provenance_fault` row in
`event_log`, which is what `obsidian-tc doctor` (a separate process) reads to warn "N committed
writes left no record". The doctor warning ages out with `event_log` retention; the counter resets
with the process. The write itself is never failed.

## Configuration

```json
{
  "provenance": {
    "enabled": true,
    "host": { "mode": "hashed" },
    "retentionDays": 365
  }
}
```

- `enabled` defaults to `true`; `false` records nothing.
- `host.mode` is `"hashed"` (default, a stable digest of the machine's hostname) or `"label"`,
  which records `host.label` verbatim and requires it.
- `retentionDays` is absent by default, which keeps records forever.

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
