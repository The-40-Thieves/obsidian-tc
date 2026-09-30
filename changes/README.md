# Release-note fragments

One file per change: `changes/<short-slug>.md`. `scripts/release.mjs` folds every fragment into the
release's section of `CHANGELOG.md` and deletes the files, so two PRs never edit the same
CHANGELOG lines. Do not edit the `[Unreleased]` block of `CHANGELOG.md` for new entries.

```markdown
---
type: Added
---
- **Lead sentence.** What changed and what a user must do about it (#123).
```

- `type` is one of `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
- The body is verbatim CHANGELOG markdown, starting with a `- ` bullet. Add the PR number as
  `(#N)` once the PR exists: the release's coverage gate looks for it.
- A change that alters the type, default or constraint of an EXISTING config key adds
  `config-schema-change: path.to.key, other.key` to the front matter; `config:schema:check`
  refuses that kind of change without it.
- `bun run check:changes` validates the fragments.
