---
title: Configuration Reference
description: Every configuration key, its type, default, and whether it's required — generated from the Zod schema.
sidebar:
  order: 9
---

Every configuration key obsidian-tc understands, generated from the Zod schema so it stays in sync
with the server. For task-oriented guidance on setting these, see the
[config.yaml guide](/configuration/config-yaml/).

:::tip
Only `vaults` is strictly required — everything else has a sensible default. A minimal config is just
`{ "vaults": [{ "id": "main", "path": "/path/to/vault" }] }`.
:::

:::note
Generated (`bun run docgen:render`); do not hand-edit the region between the markers.
:::

<!-- BEGIN GENERATED: config -->

<!-- END GENERATED: config -->
