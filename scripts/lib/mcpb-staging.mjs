// Staging-directory helpers for scripts/bundle-mcpb.ts (THE-951).
//
// The MCPB CLI's `pack` command (pinned @anthropic-ai/mcpb@2.1.2 — re-checked, still no
// `--manifest` flag on `pack --help`) always reads `manifest.json` from the root of the directory
// it packs, and the repo root's own manifest.json is the companion plugin's Obsidian manifest
// (THE-950), not the MCPB bundle manifest (which lives at mcpb/manifest.json). The previous
// approach swapped the MCPB manifest onto the live root manifest.json for the duration of the pack
// call and restored it in a `finally` — not kill-safe: a process killed between the swap and the
// restore left the live tree's manifest.json permanently overwritten (THE-950's failure mode,
// reproduced by the THE-950 review with `kill -9`). This module packs from a throwaway staging
// directory instead, so the live tree is never written to at all (except the `.mcpb` output
// itself, which lands outside the staging dir).
//
// Kept dependency-free (no `bun` import) so it can be unit-tested under plain `node --test`
// (scripts/*.test.mjs) — bundle-mcpb.ts is the only caller that needs Bun's `$` shell, to invoke
// the actual `mcpb` CLI; this module only touches the filesystem.
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Root-level entries never staged:
//   .git          — repo metadata, irrelevant to the bundle and often large.
//   dist          — the OLD build-output directory; the new .mcpb is written straight to
//                   `<repoRoot>/dist/obsidian-tc.mcpb` (the one live-tree write this module still
//                   makes), never read back through staging.
//   node_modules  — .mcpbignore already excludes it unconditionally from the packed bundle, and
//                   `os.tmpdir()` can be a different filesystem from the repo checkout (measured
//                   on this box: ext2/ext3 device IDs differ between `/` and the `/data` mount),
//                   which turns every hardlink here into a real byte copy — staging it would only
//                   cost time for bytes the CLI would drop anyway. The THE-951 report's acceptance
//                   evidence confirms omitting it does not change the packed bundle.
//   manifest.json — replaced below with mcpb/manifest.json's content; skipped here so that write
//                   is always a fresh file, never a write through a hardlink to the live tree's
//                   own root manifest.json (which would corrupt the shared inode — exactly the
//                   live-tree-write failure mode THE-951 removes).
const SKIP_ROOT_ENTRIES = new Set([".git", "dist", "node_modules", "manifest.json"]);

/**
 * Hardlinks `src` onto `dest`, falling back to a real copy when they are on different
 * filesystems (`EXDEV` — a `link(2)` limitation, not something a retry fixes). Injectable so
 * the EXDEV fallback is deterministically testable without depending on the host's mount layout.
 */
export async function linkOrCopy(
  src,
  dest,
  { link: linkFn = link, copyFile: copyFileFn = copyFile } = {},
) {
  try {
    await linkFn(src, dest);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    await copyFileFn(src, dest);
  }
}

async function stageTree(src, dest) {
  const st = await lstat(src);
  if (st.isSymbolicLink()) {
    await symlink(await readlink(src), dest);
    return;
  }
  if (st.isDirectory()) {
    await mkdir(dest, { recursive: true });
    for (const name of await readdir(src)) {
      await stageTree(join(src, name), join(dest, name));
    }
    return;
  }
  await linkOrCopy(src, dest);
}

/**
 * Populates `stagingDir` with the bundle's inputs: everything under `repoRoot` except
 * SKIP_ROOT_ENTRIES (hardlinked where possible — cheap, and the pack step only reads), plus
 * `mcpb/manifest.json`'s content written fresh as `manifest.json` at the staging root — honoring
 * `.mcpbignore` exactly as the in-place pack did, since `.mcpbignore` itself is staged like any
 * other file and the CLI applies it against the staging directory it packs.
 */
export async function stageBundleInputs(repoRoot, stagingDir) {
  for (const name of await readdir(repoRoot)) {
    if (SKIP_ROOT_ENTRIES.has(name)) continue;
    await stageTree(join(repoRoot, name), join(stagingDir, name));
  }
  const mcpbManifest = await readFile(join(repoRoot, "mcpb", "manifest.json"));
  await writeFile(join(stagingDir, "manifest.json"), mcpbManifest);
}

/**
 * Builds a staging directory under the OS temp dir, populates it via stageBundleInputs, calls
 * `pack(stagingDir, outFile)` to produce the bundle, and always removes the staging directory
 * (success or failure — the `finally` is what makes a thrown pack leave nothing behind). The live
 * tree at `repoRoot` is never written to except `outFile` itself.
 */
export async function packFromStaging(repoRoot, outFile, { pack }) {
  const stagingDir = await mkdtemp(join(tmpdir(), "obsidian-tc-mcpb-"));
  try {
    await stageBundleInputs(repoRoot, stagingDir);
    await pack(stagingDir, outFile);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
