---
type: Security
---
- **The compare-and-swap detail is read-gated.** A caller that may write a note but not read it no longer learns that note's hash: the `concurrent_modification` refusal, the `elicit_required` details, the write acks and the delete ack withhold `actual`, `prev_hash`, `quality_warning` and the whole-note `content_hash` unless the caller may read the note (`delete_note`'s `prev_hash` is now `null` for such a caller). Readers see no change.
- **`patch_note` honours `writes.requireCas` and accepts `options.idempotency_key`**, like `append_note`. `patch_active_file` inherits both through `patch_note`.
