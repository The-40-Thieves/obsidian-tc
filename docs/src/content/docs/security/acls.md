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
`.trash` are denied by default.

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
