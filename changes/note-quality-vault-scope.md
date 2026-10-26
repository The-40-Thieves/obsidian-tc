---
type: Fixed
---
- **A forget no longer leaks into other vaults' note quality.** A forgotten note path tombstoned the same path in every vault, and deleted or moved notes kept a stale quality row. Forget records its vault, legacy forget entries still apply to every vault, and a recompute removes rows for notes that no longer exist. A context export with `--vault` now carries only that vault's forgets (plus legacy ones), so importing it under another vault is no longer refused, and the same bundle imported under two vaults keeps both vaults' forgets.
