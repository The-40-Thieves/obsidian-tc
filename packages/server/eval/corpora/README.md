# Public multi-shape eval suite

ADR 0007 asks for three or more corpus shapes before a judgment mechanism can earn a default. Until this
directory existed the record held two: a private ~1,150-note multi-hop vault and the public evergreen
corpus. This suite supplies shapes that anyone can fetch and re-run, with golden sets fixed before any arm
ran. It changes no default and records no mechanism result; its one run is a harness smoke (see
`docs/EVALUATION.md`, "Multi-shape suite").

## Corpora

| corpus | shape | language | notes | licence | source |
| --- | --- | --- | ---: | --- | --- |
| `quartz-docs` | code documentation | English | 111 | MIT | `jackyzha0/quartz`, subtree `docs/` |
| `knowledge-garden` | personal garden, deep folders | Chinese (51% CJK) | 959 | MIT | `oldwinter/knowledge-garden` |
| `synthetic-multihop` | generated multi-hop chains | English | 638 | AGPL-3.0-only (this repo) | `eval/gen-multi-hop-slice.ts`, seed 652 |

Notices, commits and licence texts are in [`ATTRIBUTION.md`](./ATTRIBUTION.md). The third-party corpora are
never committed; this directory holds only the registry, the tools, the shape statistics and the golden sets.

## Fetch and pin

`corpora.json` is the registry. Each remote corpus carries a full 40-character commit (a branch or tag is
refused) and a digest of the Markdown it keeps: file count, byte count and a sha256 over every
`<relative path>\0<sha256 of the file>` line in path order. Dot-directories are skipped, as the indexer
skips them, so the digest covers exactly what a run can see.

```
bun eval/corpora/fetch-corpus.ts quartz-docs --out /data/obsidian-tc-eval/multishape/corpora/quartz-docs
bun eval/corpora/fetch-corpus.ts knowledge-garden --out /data/obsidian-tc-eval/multishape/corpora/knowledge-garden
bun eval/corpora/fetch-corpus.ts quartz-docs --verify <dir>     # re-check a directory against the pin
```

A fetch whose digest differs from the pin fails and names the mismatching field. Run these from
`packages/server`.

## How the golden sets were built

`gen-corpus-golden.ts` mines each set from the corpus files alone. Nothing comes from a retrieval arm's
ranking, so no label can favour the mechanism under test. Five mechanical classes:

| class | query | target |
| --- | --- | --- |
| `exact-title` | a note's title, unique in the corpus | that note |
| `unique-heading` | a heading carried by exactly one note | that note |
| `quote-fragment` | a fragment of a sentence found in exactly one note | that note |
| `link-context` | a sentence of note A, link markup removed, where A links to B | B |
| `bridge-2hop` | templated question; A links to B, B links to C, no A to C link either way | C |

Selection is seeded (`corpora.json` carries the seed and per-class caps), a note is the target of at most
two queries, and the generator builds the contamination guard's rule in: no note ends up quoting three or
more queries verbatim. The committed sets are therefore guard-clean by construction and pass
`assertGoldenNotInVault` on the pinned corpus. `--check` regenerates a set in memory and fails when the
committed file differs byte for byte:

```
bun eval/corpora/gen-corpus-golden.ts quartz-docs --corpus <dir> --check eval/corpora/golden/quartz-docs.json
```

The golden JSON is generator output and is excluded from biome (`biome.json`), because a reformat would make
every committed set read as stale. The synthetic set is `eval/gen-multi-hop-slice.ts` output at seed 652, committed as
`synthetic-multihop.example.yaml` (the `.example.yaml` suffix is what `scripts/check-vault-leak.mjs` accepts for a
synthetic set; it accepts a golden JSON in this directory only for a corpus id registered in `corpora.json` with a
pinned public repo, a full commit and a licence);
`test/eval-corpora.test.ts` checks it regenerates identically.

*Addendum, 2026-10-04.* `suite-plan.json` records the synthetic set's sha256 as `f2967b0c...8307`, the digest of the file
as first generated. The committed file differs from it in line 1 only: the generator's header comment named an internal
ticket, which does not belong in a public data file, and the header was reworded (the committed sha256 is
`98b67277c9ffe4292a21a33841955c2a4aa42679b2b9f32f66125a2a8f3ccf02`). The 120 queries, ids, paths and descriptions are
byte-identical, and `suite-plan.json` is left as written so the preregistration hash does not move.

## Planned power

`suite-plan.ts` computes each corpus's shape statistics (through `vault/links.ts`, the code the indexer
uses) and its planned minimum detectable effect through `powerReport`, at the widest and the narrowest
paired nDCG@10 spread measured so far. `suite-plan.json` is the plan written before the smoke run.

| corpus | n | MDE nDCG@10, spread 0.206 | MDE, spread 0.135 |
| --- | ---: | ---: | ---: |
| evergreen (existing) | 78 | 0.065 | 0.043 |
| quartz-docs | 120 | 0.053 | 0.035 |
| knowledge-garden | 220 | 0.039 | 0.026 |
| synthetic-multihop | 120 | 0.053 | 0.035 |

Per-class n: quartz-docs link-context 20, bridge-2hop 10, quote-fragment 30, unique-heading 30,
exact-title 30; knowledge-garden 40, 30, 50, 50, 50.

## What the indexer keeps

The pins above count Markdown files; the index counts notes that produce at least one chunk. `chunkNote`
(`src/search/chunk.ts`) consumes heading lines into the breadcrumb and drops any section whose body text is
empty, so a note that is only frontmatter, or only headings, has a `notes` row and no chunk. That is why the
`knowledge-garden` index of the part-2 matrix holds 832 notes and 2422 chunks of 959 files. The 127 missing
notes were checked one by one: 123 are frontmatter-only (21 to 488 bytes) and 4 carry only headings (34 to 47 characters). Nothing was excluded for size, language or a parse
failure (the build log reports 0 embed failures, 0 frontmatter failures, 0 secret-gated). The same rule leaves 1 of
111 `quartz-docs` notes and 66 of 1357 `evergreen` notes without chunks, none of which has body text beyond headings, and
`synthetic-multihop` indexes 638 of 638. A golden target that is one of these notes cannot be retrieved by any arm; the
runs report golden-set coverage (`120/120` on quartz-docs) before scoring.
