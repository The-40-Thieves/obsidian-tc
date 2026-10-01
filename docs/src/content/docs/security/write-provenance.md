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
in the recorder is reported on stderr and never fails or blocks the write it describes.

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

## Verifying

```bash
obsidian-tc provenance verify                      # every vault with a chain
obsidian-tc provenance verify --vault notes --json
obsidian-tc provenance verify --allow-unsigned
```

The command is read-only, opens `cache.db` and the registry read-only, and exits **1** when any
chain fails. For each vault it prints the record count, how many are signed and unsigned, and every
problem (`hash_mismatch`, `seq_gap`, `chain_break`, `head_mismatch`, `unknown_kid`, `bad_signature`,
and the head variants). If the auth registry was initialised but `<cacheDir>/auth.db` is lost, it refuses and
says so: with no keys every signature would read as tampered when the truth is that nothing can be
checked.

**`--allow-unsigned`** accepts records that carry no signature. Without it an unsigned record is a
**failure**, deliberately: if unsigned were acceptable, an attacker could strip every signature and
rewrite the chain. Pass the flag for stdio-only or pre-EdDSA deployments where chain-only integrity
is what you have; a record that *has* a signature is always checked, flag or not.

`obsidian-tc doctor` runs the same verification as the **provenance chain** check: it fails on any
sign of tampering, warns when records exist without signatures or the chain cannot be read, and
notes (without warning) a fresh install that has no EdDSA key yet.

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

## Retention

`provenance.retentionDays` is **unset by default**: this is an audit trail and pruning it is an
explicit decision. When set, the maintenance sweep removes each vault's records older than the
window as one contiguous prefix and moves a **signed prune anchor** (in the head row) up to the last
record dropped. The surviving chain therefore still verifies. Removing any record that is not part
of the oldest prefix, or dropping a prefix without a matching signed anchor, still fails
verification. A sweep that has no signer available leaves a signed chain alone rather than
downgrading its head to unsigned. The sweep reports the count as `provenance`.
