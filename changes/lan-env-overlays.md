---
type: Added
---
- **Environment overlays for LAN installs.** `OBSIDIAN_TC_ALLOWED_HOSTS` adds Host values (`host`, `host:port`, IPv4 or bracketed IPv6) to the DNS-rebinding allow-list, and `OBSIDIAN_TC_AUDIENCE` sets `auth.audience`. A JWT server reached at a LAN address (`http://umbrel.local:8765`) can now be configured from the environment alone, without a public `https` URL. Exact entries only: wildcards are refused.
