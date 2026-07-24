# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase.

This repo is **single-context**: one `CONTEXT.md` and one `docs/adr/` at the repo root, covering all
four workspaces (`packages/server`, `packages/plugin`, `packages/native`, `packages/shared`). The
vocabulary that matters here spans packages rather than living inside one, so a single glossary is
the right unit. If a package's language genuinely diverges later, switch to the multi-context layout
below.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context.
  Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. In multi-context repos,
  also check `packages/<name>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest
creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (this repo):

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-....md
│   └── 0002-....md
└── packages/
```

Multi-context repo (presence of `CONTEXT-MAP.md` at the root):

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── packages/
    ├── server/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── native/
        ├── CONTEXT.md
        └── docs/adr/
```

## Not to be confused with

`docs/` is also the Astro workspace that publishes obsidian-tc.the40thieves.io. The published site
reads only from `docs/src/content/docs`, so `docs/agents/` and `docs/adr/` are agent- and
maintainer-facing, and do not appear on the website.

`docs/superpowers/{plans,specs}` is a separate, untracked convention belonging to the Superpowers
plugin. It is not part of the domain docs described here.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a
test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly
avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing
language the project doesn't use (reconsider) or there's a real gap (note it for
`/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
