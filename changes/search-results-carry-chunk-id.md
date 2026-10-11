---
type: Fixed
tool-description-change: search_and_read, search_semantic, search_vault
---
- **Search results carry `chunk_id` in every shape, so `record_retrieval_feedback` works from them.** `search_and_read` puts `chunk_id` on each item in both modes and both formats: the note's top-ranked chunk in note mode, the matched chunk in section mode. Before, note mode and concise output had none, so a client could not report retrieval feedback for most results. `search_semantic` and `search_vault` keep `chunk_id` under `response_format=concise` (`verbosity=terse`) on each hit that has one, so a concise `search_semantic` hit is `{path, score, chunk_id}`. Hits without a chunk (`search_text`, `search_regex`, `search_jsonlogic`) are unchanged.
