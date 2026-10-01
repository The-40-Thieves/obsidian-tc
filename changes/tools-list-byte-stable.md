---
type: Added
---
- **Test: `tools/list` and `initialize` instructions are byte-identical across server restarts.** Boots the real server twice per facade mode (triad, domain, flat) with different cache directories and vault contents and compares sha256 of the exact `result` bytes, so a shuffled tool order or a volatile value in a tool description (which would invalidate a client's prompt cache) fails CI. Test only; no runtime change.
