---
type: Fixed
---
- **Indexing honors the configured policy across edits and restarts.** Note writes and watcher updates now use the same chunk size, embedding batch size, concurrency and token budget as whole-vault indexing, and boot and scheduled reconciliation keep the configured chunk size. Before this, a vault with a non-default `indexing.chunkTokens` re-chunked edited notes at the 512-token default and rebuilt them again at the configured size on the next reconcile.
