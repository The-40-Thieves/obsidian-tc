---
type: Fixed
---
- **Host guard refuses a bare name under a bracketed config entry.** An `allowedHosts` or `allowedOrigins` entry written as `[name]` (brackets around a non-IPv6 name) no longer admits the bare `name` Host. Brackets are stripped only around an IPv6 literal. Entries written as `[ipv6]` are unchanged.
