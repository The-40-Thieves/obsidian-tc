---
type: Fixed
---
- **Indexing honors the configured policy across edits and restarts.** Note writes and watcher updates now use the same chunk size and embedding batch size, concurrency, and token budget as whole-vault indexing. Boot and scheduled reconciliation also retain the configured chunk size, keeping chunk boundaries consistent after edits and restarts.
