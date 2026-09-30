---
type: Added
---
- **`toolFacade.explainAutoMode` explains the auto-mode decision.** Set it to `true` (default `false`) and each `toolFacade.mode: "auto"` resolution writes one structured `toolFacade.explain` JSON line to stderr (client name, the rule that fired, the matched table key, the mode chosen), and `server_health`'s `toolFacade.explanation` returns the same record for the calling client. `obsidian-tc doctor` reports the flag. Pure observability: the chosen mode is identical with the flag on or off (#1059).
