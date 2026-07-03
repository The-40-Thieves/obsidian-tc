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

## ACL configuration

The folder ACL is a config block: `acl` at the root (the default for every vault)
and, optionally, a per-vault `acl` that overrides it. Both share the same shape:

- **`readOnly`** (default `false`) — a vault-wide read-only kill switch; when `true`,
  every write/delete is refused regardless of scopes.
- **`defaultScopes`** — scopes granted to a caller when no `rules` entry matches.
- **`rules`** — `{ "glob": "…", "scopes": [ … ] }` entries granting scopes on matching
  paths.
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
