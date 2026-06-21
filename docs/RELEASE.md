# Release runbook

obsidian-tc ships as self-run artifacts. Releases are **tag-triggered and human-gated**:
pushing a `v*` tag fires `.github/workflows/publish.yml`. Nothing publishes on a branch
push or pull request. CI (build/test, coverage, native, plugin, docs) runs on every PR;
publishing does not.

## What a tag produces

- **npm** three umbrella packages (`obsidian-tc`, `@the-40-thieves/obsidian-tc-shared`,
  `@the-40-thieves/obsidian-tc-native`) plus four platform sub-packages
  (`@the-40-thieves/obsidian-tc-native-{linux-x64-gnu,darwin-x64,darwin-arm64,win32-x64-msvc}`),
  published with npm provenance.
- **Standalone binaries** `bun build --compile` for the four platforms.
- **Companion plugin zip** for `.obsidian/plugins/`.
- **Docker image** `ghcr.io/the-40-thieves/obsidian-tc` (amd64 + arm64).
- **Draft GitHub Release** binaries, plugin zip, and `SHASUMS256.txt`.

## Atomic npm publish (THE-224)

npm publishes are immutable: a published version cannot be overwritten or moved backward,
only deprecated. Publishing three interdependent umbrella packages straight to `latest` in
sequence is therefore unsafe. A failure after the first publish would strand a half-released,
version-skewed set on `latest` with no clean rollback, and a re-run would fail on the
already-published packages.

The workflow avoids this:

1. **Preflight.** Before any publish, assert every target version is unpublished: the three
   umbrellas and the four platform sub-packages. If any already exists on the registry the
   job fails immediately, so a re-run can never half-publish a skewed release. Fix by bumping
   the version and re-tagging.
2. **Publish platform sub-packages.** The four leaf `@the-40-thieves/obsidian-tc-native-*`
   packages publish via `napi prepublish`, which also pins the native umbrella''s
   `optionalDependencies` to exact versions. These are leaves: until an umbrella that
   references them is promoted to `latest`, they are unreferenced and harmless.
3. **Publish umbrellas to `pending`.** The three umbrellas publish to a holding `pending`
   dist-tag, never straight to `latest`. While this runs, `latest` still points at the
   previous good release, so installers are unaffected by a partial failure.
4. **Promote to `latest`, server last.** Once all three are on `pending`, promote each to
   `latest` with `npm dist-tag add`, in dependency order (native, shared, then the
   user-facing `obsidian-tc` server **last**). `dist-tag add` is idempotent, so a promotion
   that fails partway can be re-run. `obsidian-tc@latest` only moves after its dependencies
   are already on `latest`.

## Recovery

- **Publish-to-`pending` failed partway.** `latest` is untouched; users are unaffected.
  npm versions are immutable, so do not retry the same version: bump the patch and re-tag.
  Any versions that reached `pending` are orphaned and harmless; the next release overwrites
  the `pending` tag.
- **Promotion failed partway** (for example native and shared promoted, server not). Re-run
  the job, or promote by hand: `npm dist-tag add obsidian-tc@<version> latest`. Inspect tags
  with `npm dist-tag ls obsidian-tc` (likewise for the shared and native umbrellas).
- **Inspect a release.** `npm view obsidian-tc dist-tags` shows where `latest` and `pending`
  point.

## Caveat: brand-new package names

npm forces the first published version of a new package name onto `latest` regardless of
`--tag`. The `pending` isolation therefore only protects packages that already exist on the
registry (all current obsidian-tc packages do). When introducing a brand-new package name,
publish a throwaway prerelease first, or accept that its first real version lands on `latest`.