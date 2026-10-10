---
type: Fixed
---
- **`vault_health_score`, `find_orphans`, `find_unresolved_links`, `find_link_cycles`, `get_backlinks`, `audit_provenance`, `get_link_strength` and `suggest_links` no longer freeze the server while they scan.** Each read and parsed every note in one synchronous run, which held the event loop for 6-8 s on a 20 000-note vault: a timer, a second tool call and SIGTERM all waited behind it. The scans now hand the loop back every 5 ms of work (the longest remaining stall is about 40-60 ms, measured on that vault), and a cancelled call stops scanning instead of finishing the walk. Results are unchanged byte for byte, pinned by a differential test against the pre-change output. `lint_wiki` and the scheduled wiki lint share the same scan code and still run it in one piece.
