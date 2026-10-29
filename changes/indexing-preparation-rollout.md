---
type: Added
---
- **Opt-in modular preparation for note indexing.** Set `indexing.writePreparation` to `modular` to use the isolated preparation path for note writes and watcher updates. The default remains `legacy`; both paths honor configured chunk and embedding limits and share the same atomic persistence. Change the setting back and restart to roll back without rebuilding the index.
