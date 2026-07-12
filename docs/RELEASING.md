# Releasing obsidian-tc

The release flow is **single-command staging + a human-pushed tag**. Everything before the tag is
automated and gated; the tag is the one deliberate human step — an irreversible npm/ghcr publish
should never fire from an unattended merge (THE-256). Pushing a `v*` tag fires
`.github/workflows/publish.yml`; nothing publishes on a branch push or pull request. CI
(build/test, coverage, native, plugin, docs) runs on every PR — publishing does not.

## Steps

1. **Stage the bump.** From a clean `main`:

   ```sh
   bun scripts/release.mjs <patch|minor|major|x.y.z>
   ```

   This sets the version across every `package.json` + distribution file (server, native, shared,
   `server.json`, the MCPB `manifest.json`, and the companion plugin's `manifest.json` /
   `package.json` / `versions.json` in lockstep), rolls `CHANGELOG.md`'s `[Unreleased]` section into
   the new version, refreshes `bun.lock`, runs `bun run format`, and runs the coherence gate. It does
   **not** commit, push, or tag.

2. **Branch + PR.** Commit the staged changes on a release branch, open a PR, and let CI run:
   build/test across Linux/macOS/Windows, install-smoke, `ci-version` (version coherence + the
   tool-count headline pin), and `ci-native`. Address any autofix-bot commits (fetch/rebase before
   pushing follow-ups).

3. **Merge to `main`.**

4. **Tag.** A human pushes the annotated tag `v<x.y.z>`, firing `publish.yml`: the eight-triple
   native build matrix (linux gnu+musl x64/arm64, darwin x64/arm64, win32 x64/arm64) → npm
   (`pending` → `latest`) → standalone binaries → Docker/ghcr → the `.mcpb` bundle → the
   companion-plugin assets → a draft GitHub Release with checksums. See *What a tag produces* and
   *Atomic npm publish* below for the details.

5. **Publish the draft Release** once the assets are attached and verified.

## What a tag produces

- **npm** — three umbrella packages (`obsidian-tc`, `@the-40-thieves/obsidian-tc-shared`,
  `@the-40-thieves/obsidian-tc-native`) plus four platform sub-packages
  (`@the-40-thieves/obsidian-tc-native-{linux-x64-gnu,darwin-x64,darwin-arm64,win32-x64-msvc}`),
  published with npm provenance.
- **Standalone binaries** — `bun build --compile` for the four platforms.
- **Companion plugin zip** — for `.obsidian/plugins/` (plus the loose `manifest.json` / `main.js` /
  `styles.css` set for BRAT).
- **`.mcpb` bundle** — the single-file MCPB server bundle.
- **Docker image** — `ghcr.io/the-40-thieves/obsidian-tc` (amd64 + arm64).
- **Draft GitHub Release** — binaries, plugin zip, and `SHASUMS256.txt`.

## Atomic npm publish (THE-224)

npm publishes are immutable: a published version cannot be overwritten or moved backward, only
deprecated. Publishing three interdependent umbrella packages straight to `latest` in sequence is
therefore unsafe — a failure after the first publish would strand a half-released, version-skewed set
on `latest` with no clean rollback. The workflow avoids this:

1. **Preflight.** Before any publish, assert every target version is unpublished (the three umbrellas
   and the four platform sub-packages). If any already exists on the registry the job fails
   immediately, so a re-run can never half-publish a skewed release. Fix by bumping the version and
   re-tagging.
2. **Publish platform sub-packages.** The four leaf `@the-40-thieves/obsidian-tc-native-*` packages
   publish via `napi prepublish`, which also pins the native umbrella's `optionalDependencies` to
   exact versions. Until an umbrella referencing them is promoted to `latest`, they are unreferenced
   and harmless.
3. **Publish umbrellas to `pending`.** The three umbrellas publish to a holding `pending` dist-tag,
   never straight to `latest`. While this runs, `latest` still points at the previous good release,
   so installers are unaffected by a partial failure.
4. **Promote to `latest`, server last.** Once all three are on `pending`, promote each with
   `npm dist-tag add` in dependency order (native, shared, then the user-facing `obsidian-tc` server
   **last**). `dist-tag add` is idempotent, so a promotion that fails partway can be re-run;
   `obsidian-tc@latest` only moves after its dependencies are already on `latest`.

## Recovery

- **Re-cutting a failed release.** Publishing is immutable (no rollback). If a tag's publish fails
  partway, fix on `main` and delete + re-create the tag at the fixed HEAD; never reuse a partially
  published version number.
- **Publish-to-`pending` failed partway.** `latest` is untouched; users are unaffected. Any versions
  that reached `pending` are orphaned and harmless — the next release overwrites the `pending` tag.
- **Promotion failed partway** (e.g. native and shared promoted, server not). Re-run the job, or
  promote by hand: `npm dist-tag add obsidian-tc@<version> latest`. Inspect tags with
  `npm dist-tag ls obsidian-tc` (likewise for the shared and native umbrellas).
- **Inspect a release.** `npm view obsidian-tc dist-tags` shows where `latest` and `pending` point.

## Caveat: brand-new package names

npm forces the first published version of a new package name onto `latest` regardless of `--tag`. The
`pending` isolation therefore only protects packages that already exist on the registry (all current
obsidian-tc packages do). When introducing a brand-new package name, publish a throwaway prerelease
first, or accept that its first real version lands on `latest`.

## Invariants enforced in CI

- All version strings agree (`scripts/check-version-coherence.mjs`).
- The companion plugin's manifest version equals the repo version and `versions.json` lists it.
- The documented tool-count headline matches the registered surface (THE-306).

## Community-store submission (companion plugin)

The plugin is BRAT-installable from any tagged release (the loose 3-file set is attached). Formal
Obsidian community-store listing is a one-time manual PR to
[`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases); because the plugin
lives in a monorepo subfolder, copy its `manifest.json` + `versions.json` to the submission as the
store tooling expects them at the repo root.
