---
type: Deprecated
---
- **`allowPlainHttp` is deprecated; use `plainHttpHosts`.** On `experiential.citationInfer.judge` and `wikiJudge`, `allowPlainHttp: true` now means only that this `baseUrl`'s own host is listed in `plainHttpHosts`, and it no longer waives the connect-time private-address check: a host that resolves to a public address is refused even with the flag. `obsidian-tc doctor` and `server_health` (a new optional `deprecations` list) warn while it is set. The flag is removed in the next major release.
