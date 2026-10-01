---
title: Scopes & Folder ACLs
description: How scopes, folder ACLs, and scope-class rate tiers gate every tool call.
---

## Scopes

Every tool declares the scopes it requires. A caller's granted scopes (from its
JWT, or full `*` for trusted stdio) must satisfy them or the call is denied with
`forbidden` (missing required scope); an unauthenticated call is denied with
`unauthorized`.

## Folder ACLs

Beyond scopes, a **folder ACL** constrains which vault paths a caller may read,
write, or delete, using glob allow/deny rules (e.g. allow `02-projects/**`, deny
`99-private/**`). A path outside the whitelist is denied with `acl_denied`
(counted as `acl_denied_total`, emitted as `tc.acl.denied`). Paths are resolved and
canonicalized through symlinks before the check and matched Unicode-NFC-insensitively,
`../` escapes cannot bypass it, and the control directories `.obsidian` / `.git` /
`.trash` are denied by default. A **hard-linked** regular file (`st_nlink > 1`) is also
rejected under a folder ACL: a hard link aliases an inode that path canonicalization cannot
dereference, so it could otherwise serve a file outside the allowed folder. Reads run on the
opened file descriptor (fstat + read on the same object).

### Memory entities follow the read ACL

`get_entity` and `query_entity_graph` hold `read:memory`, and the folder read ACL applies to them
as well. An entity's own projection note is `<memory folder>/<type>/<name>.md` (default folder
`memory`), and that note renders the same observations and `[[links]]` the tools return, so an
entity is readable exactly when `read_note` could read that note: under `readPaths`, under
`strictReadDefault`, and against any rule-scopes on its path. This holds for entities created with
`materialize: false` too (no file exists, the path is computed) and uses the entity's current name,
so a renamed entity is not judged by a stale path.

Denied means missing. An entity the caller cannot read returns the same `entity not found` error a
nonexistent id returns (the same goes for the write and lifecycle tools that look an entity up:
`add_observation`, `link_entities`, `unlink_entities`, `rename_entity`, `delete_entity`), it does
not count toward by-name ambiguity, and `get_entity` omits relations to it. `query_entity_graph`
never traverses an unreadable entity, so entities reachable only through one do not appear, and the
page, `next_cursor` and `total_returned` are computed after that filtering. Write tools still need
their own write ACL on top.

A vault with a restricted `readPaths` that does not list the memory folder therefore hides its
memory. Add `memory/**` (or your configured `memory.folder`) to `readPaths`; `obsidian-tc doctor
--probe` reports `memory.read-acl` when existing entities are hidden this way.

## ACL configuration

The folder ACL is a config block: `acl` at the root (the default for every vault)
and, optionally, a per-vault `acl` that overrides it. Both share the same shape:

- **`readOnly`** (default `false`) — a vault-wide read-only kill switch; when `true`,
  every write/delete is refused regardless of scopes.
- **`defaultScopes`** — scopes **required** to operate on a path that matches no `rules`
  entry (P1.4). Empty (the default) adds no requirement.
- **`rules`** — `{ "glob": "…", "scopes": [ … ] }` entries. A rule's `scopes` are the
  scopes a caller must hold — **in addition to the tool's own required scopes** — to
  read/write/delete a matching path (P1.4). The **last** matching rule wins (replacing,
  not merging). Enforced centrally at dispatch on tool *operations*, and by every handler that
  reads a note itself. Search, listing, graph and plugin-passthrough results, and the counts derived
  from them, drop a path whose rule-scopes the caller lacks, exactly as `read_notes` would refuse it.
- **`readPaths` / `writePaths` / `deletePaths`** — optional glob whitelists. When a
  list is **omitted**, that operation is unrestricted (the M0 default); when
  **present**, a path must match at least one entry or the call is denied.
- **`strictReadDefault`** (default `false`) — when `true`, an *undefined* `readPaths`
  fails **closed** on reads (not just on bridge enumeration).

Root ACL:

```json
{
  "acl": {
    "readOnly": false,
    "readPaths": ["**"],
    "writePaths": ["02-projects/**", "90-memory/**"],
    "deletePaths": ["02-projects/**"],
    "strictReadDefault": false
  }
}
```

Per-vault override — the canonical "write vault A, read-only vault B in one process"
policy. A vault with no `acl` inherits the root ACL as its default:

```json
{
  "vaults": [
    { "id": "work", "path": "/vaults/work",
      "acl": { "writePaths": ["**"], "deletePaths": ["**"] } },
    { "id": "reference", "path": "/vaults/reference",
      "acl": { "readOnly": true } }
  ]
}
```

## Scope classes & rate tiers

Each tool's required scopes resolve to one **scope class**, chosen by
most-restrictive precedence:

```
bulk  >  execute  >  admin  >  delete  >  write  >  read
```

A dispatch-wide token-bucket limiter throttles by class. The default tiers
(`perMinute` refill, `burst` ceiling):

| Class | Per minute | Burst |
| --- | --- | --- |
| read | 600 | 100 |
| write | 60 | 20 |
| delete | 60 | 20 |
| bulk | 10 | 3 |
| execute | 5 | 1 |
| admin | 5 | 1 |

A throttled call returns `throttled` ("rate limit exceeded"), increments
`rate_limit_hits_total`, and emits `tc.rate_limit.hit`. The limiter is
deterministic (it reads an injected clock), so its behavior is fully testable.
