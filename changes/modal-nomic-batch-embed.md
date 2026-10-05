### Added

- `eval/export-chunk-texts.ts` and `eval/modal_embed_nomic.py`: export every chunk's shipped
  embed-text and embed it on one Modal GPU, running the SAME pinned ONNX graph (same repo, revision,
  `onnx/model.onnx`, mean pooling, L2 normalization, no task prefix) that `embeddings.provider:
  "local"` runs on CPU. Only the execution provider differs, so the vectors are interchangeable with
  the ones the query side produces — which is required, since one `provider.id` serves both document
  and query embedding. Pinned checksums are verified against `model-info.ts`; a mismatch is fatal.

### Fixed

- `eval/load-gpu-vecs.ts` derived `chunk_embeddings.model` by string concat, which is not
  `provider.id` for the `local` embedder — that folds quantization and revision in
  (`local:nomic-embed-text-v1.5:fp32`). It now asks the provider. The old concat addressed a model
  string nothing had written and updated zero rows while reporting success; writing zero rows is now
  an error. Adds `--insert`, which upserts, for loading vectors under a provider id that has no rows
  yet (the PK is `(chunk_id, model)`, so a provider change has nothing to UPDATE).
