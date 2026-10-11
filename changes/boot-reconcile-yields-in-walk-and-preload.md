---
type: Fixed
---
- **The boot reconcile now hands the event loop back while it walks the vault and loads chunk state, not only between notes.** Those two phases still ran as one synchronous block ahead of the first per-note yield (about 0.3 s per 20 000 notes, longer on a big vault), during which no `tools/call` and no SIGTERM was serviced. With the boot reconcile's abort signal the walk reuses the scans' time-sliced driver and the chunk-state load reads in 1024-row pages with a turn between them; the notes seen, chunks and stats are identical. A pass without a signal (`index_vault`, the CLI) is unchanged.
