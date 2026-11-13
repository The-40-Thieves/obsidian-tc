---
title: Configuration Reference
description: Every configuration key, its type, default, and whether it's required — generated from the Zod schema.
---

Every configuration key reliquary-tc understands, generated from the Zod schema so it stays in sync
with the server. For task-oriented guidance on setting these, see the
[config.yaml guide](/configuration/config-yaml/).

<Tip>
Only `vaults` is strictly required — everything else has a sensible default. A minimal config is just
`{ "vaults": [{ "id": "main", "path": "/path/to/vault" }] }`.
</Tip>

<Note>
Generated (`bun run docgen:render`); do not hand-edit the region between the markers.
</Note>

<!-- BEGIN GENERATED: config -->

<!-- END GENERATED: config -->
