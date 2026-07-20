# docgen — automated documentation pipeline (THE-470)

Generates the reference docs from the code so they can never drift. See Linear THE-470 (epic) and its
sub-issues THE-471…THE-477.

## Pipeline

```
code ──(extractors, THE-471)──▶ docs-model.json ──(renderers, THE-472)──▶ markdown
                                                          │
                       inject.ts (THE-473) ───────────────┼─▶ README.md / ARCHITECTURE.md  (marker regions)
                       astro (THE-474) ──────────────────┼─▶ docs/ site
                       wiki publisher (THE-475) ─────────┴─▶ obsidian-tc.wiki.git
                                                          │
                       drift gate + coverage lint (THE-476) enforces regeneration in CI
```

## What's here now (bootstrap)

- **`model.ts`** — `DocsModel`, the single normalized structure every extractor targets and every
  renderer reads (THE-471 foundation).
- **`inject.ts`** — `injectGenerated(source, name, content)` (THE-473): idempotent replacement of a
  `<!-- BEGIN GENERATED: name --> … <!-- END GENERATED: name -->` region. Prose outside markers is
  preserved byte-for-byte.

## Next commits (THE-471 extractors)

- `extract-tools.ts` — enumerate the registry, `describeCapability` → `ToolDoc[]`
- `extract-config.ts` — walk the config schema → `ConfigDoc[]`
- `extract-metrics.ts` / `extract-errors.ts` / `extract-schema.ts`

## Markers

Any hand-authored doc opts in to a generated block by adding a marker pair:

```markdown
<!-- BEGIN GENERATED: tools -->
<!-- END GENERATED: tools -->
```

`injectGenerated` fills only between the markers; everything else stays as written. The docs-drift CI
gate (THE-476) regenerates and `git diff --exit-code`s these regions, so a PR that changes a tool or
config key without regenerating fails.
