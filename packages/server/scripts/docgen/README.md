# docgen — automated documentation pipeline

Generates the reference docs from the code so they can never drift. See the tracking epic and its
sub-issues.

## Pipeline

```
code ──(extractors)──▶ docs-model.json ──(renderers)──▶ markdown
                                                          │
                       inject.ts ───────────────┼─▶ wiki / docs pages  (marker regions, filled at build)
                       astro ──────────────────┼─▶ docs/ site
                       wiki publisher ─────────┴─▶ obsidian-tc.wiki.git
                                                          │
                       drift gate + coverage lint enforces regeneration in CI
```

Marker regions are committed **empty** and filled at build time (`bun run docgen:render`; docs
`gen:regions`, the wiki publish step). `docgen:render -- --reset` empties them again and
`docgen:render -- --check` is the CI gate: every region must be canonical-empty, every target must
still render non-empty, and an orphan marker or a broken extractor fails. Committing a filled region
would make any two PRs that move a generated fact conflict on it. README.md and ARCHITECTURE.md carry
no region: they link to the generated tool catalog instead.

## What's here now (bootstrap)

- **`model.ts`** — `DocsModel`, the single normalized structure every extractor targets and every
  renderer reads (foundation).
- **`inject.ts`** — `injectGenerated(source, name, content)`: idempotent replacement of a
  `<!-- BEGIN GENERATED: name --> … <!-- END GENERATED: name -->` region. Prose outside markers is
  preserved byte-for-byte.

## Next commits (extractors)

- `extract-tools.ts` — enumerate the registry, `describeCapability` → `ToolDoc[]`
- `extract-config.ts` — walk the config schema → `ConfigDoc[]`
- `extract-metrics.ts` / `extract-errors.ts`

## Markers

Any hand-authored doc opts in to a generated block by adding a marker pair:

```markdown
<!-- BEGIN GENERATED: tools -->
<!-- END GENERATED: tools -->
```

`injectGenerated` fills only between the markers; everything else stays as written. The docs-drift CI
gate regenerates and `git diff --exit-code`s these regions, so a PR that changes a tool or
config key without regenerating fails.

## Per-tool pages (build time, not committed)

`tool-pages.ts` writes one Starlight page per registered tool into the gitignored
`docs/src/content/docs/tools/reference/`; `docs/package.json` runs it before `astro build`/`dev`.
Only the combined catalog is committed (its rows link to the pages), so a new tool never conflicts
on ~170 generated files. `bun run docgen:tool-pages-check` (here) or `bun run check:tool-pages`
(in `docs/`, after a build, also counts the built pages) fails if pages, registry and catalog
disagree.
