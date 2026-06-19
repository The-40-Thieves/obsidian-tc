---
title: Scopes & Folder ACLs
description: How scopes, folder ACLs, and scope-class rate tiers gate every tool call.
---

## Scopes

Every tool declares the scopes it requires. A caller's granted scopes (from its
JWT, or full `*` for trusted stdio) must satisfy them or the call is denied with
`acl_denied` — and the denial is counted (`acl_denied_total`) and emitted as a
`tc.acl.denied` event.

## Folder ACLs

Beyond scopes, a **folder ACL** constrains which vault paths a caller may read or
write, using glob allow/deny rules (e.g. allow `02-projects/**`, deny `99-private/**`).
Path arguments are normalized before the check, so `../` escapes cannot bypass it.

## Scope classes & rate tiers

Each tool's required scopes resolve to one **scope class**, chosen by
most-restrictive precedence:

```
bulk  >  execute  >  admin  >  write  >  read
```

A dispatch-wide token-bucket limiter throttles by class. The default tiers
(`rate` tokens/interval, `burst` ceiling):

| Class | Rate | Burst |
| --- | --- | --- |
| read | 600 | 100 |
| write | 60 | 20 |
| bulk | 10 | 3 |
| execute | 5 | 1 |
| admin | 5 | 1 |

A throttled call returns `rate_limit_exceeded` with `retry_after_seconds`,
increments `rate_limit_hits_total`, and emits `tc.rate_limit.hit`. The limiter is
deterministic (it reads an injected clock), so its behavior is fully testable.
