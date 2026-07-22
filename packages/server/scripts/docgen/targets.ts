// docgen — the single list of files that carry generated content.
//
// This exists because the list was duplicated: render.ts wrote seven targets while suggest-prose.ts
// watched a hardcoded four for changes. Adding README.md and ARCHITECTURE.md as render targets
// (THE-473) therefore left the prose watcher blind to them — it reported "no generated-reference
// changes" for a commit that had just rewritten both files.
//
// One list, two consumers. A new generated surface is picked up by the prose watcher automatically,
// so the two can no longer drift apart.

/** Repo-relative paths of every file with a `<!-- BEGIN GENERATED: … -->` region. */
export const GENERATED_DOC_FILES = [
  // GitHub wiki (THE-475 publishes these).
  "docs/wiki/Tool-Reference.md",
  "docs/wiki/Configuration.md",
  "docs/wiki/Home.md",
  // Astro docs site (THE-474).
  "docs/src/content/docs/tools/tool-catalog.md",
  "docs/src/content/docs/configuration/config-reference.md",
  // Hand-authored narrative docs (THE-473) — only the marked region is generated.
  "README.md",
  "ARCHITECTURE.md",
] as const;

/**
 * The subset whose prose a human maintains around the generated block. A reference table moving is
 * a fact; whether the surrounding narrative still reads correctly is a judgement, which is what the
 * prose suggestion (THE-477) is for.
 */
export const NARRATIVE_DOC_FILES = ["README.md", "ARCHITECTURE.md"] as const;
