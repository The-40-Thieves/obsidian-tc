---
type: Fixed
---
- **Index-reset guidance preserves durable state.** Embedding migration and configuration documentation now use the confirmed, table-scoped reset tool instead of recommending deletion of `cache.db`, which also stores write provenance and the source-of-truth memory graph. Regression coverage verifies that reset preserves those records and materialized notes.
