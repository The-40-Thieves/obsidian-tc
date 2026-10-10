# Release-note fragments

One file per change: `changes/<short-slug>.md`. `scripts/release.mjs` folds every fragment into the
release's section of `CHANGELOG.md` and deletes the files, so two PRs never edit the same
CHANGELOG lines. Do not edit the `[Unreleased]` block of `CHANGELOG.md` for new entries.

```markdown
---
type: Added
---
- **Lead sentence.** What changed and what a user must do about it.
```

- `type` is one of `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
- The body is verbatim CHANGELOG markdown, starting with a `- ` bullet. Do NOT write the PR number:
  a PR cannot know it before it is opened, and committing it afterwards forces a second full
  verification run. `scripts/release.mjs` appends `(#N)` to the end of the first bullet from the
  history (the `Merge pull request #N` commit that brought the fragment in, or a trailing `(#N)` on
  a squash commit). A fragment that already cites `(#N)` is left as written, and a release whose
  fragment has no determinable PR refuses and names the file. The release needs full history
  (`git fetch --unshallow`).
- A change that alters the type, default or constraint of an EXISTING config key adds
  `config-schema-change: path.to.key, other.key` to the front matter; `config:schema:check`
  refuses that kind of change without it.
- A change that rewords an advertised tool description adds
  `tool-description-change: tool_name, other_tool` to the front matter (claude.ai re-prompts for
  approval when a description changes). Run `bun run tool-descriptions:update` in `packages/server`
  to refresh the snapshot first; `check:tool-description-acks` refuses a changed entry that no
  fragment names. A new or removed tool needs nothing.
- `bun run check:changes` validates the fragments.
