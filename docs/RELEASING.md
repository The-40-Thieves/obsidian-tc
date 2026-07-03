# Releasing obsidian-tc

The release flow is **single-command staging + a human-pushed tag**. Everything before the tag is
automated and gated; the tag is the one deliberate human step — an irreversible npm/ghcr publish
should never fire from an unattended merge (THE-256).

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

4. **Tag.** A human pushes the annotated tag `v<x.y.z>`. This fires `publish.yml`:
   npm (8 native triples → umbrella, `pending` → `latest`) → standalone binaries → Docker/ghcr →
   the `.mcpb` bundle → the companion-plugin assets (the zip **and** the loose `manifest.json` /
   `main.js` / `styles.css` set for BRAT) → a draft GitHub Release with checksums.

5. **Publish the draft Release** once the assets are attached and verified.

## Re-cutting a failed release

Publishing is immutable (no rollback). If a tag's publish fails partway, fix on `main` and delete +
re-create the tag at the fixed HEAD; never reuse a partially published version number.

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
