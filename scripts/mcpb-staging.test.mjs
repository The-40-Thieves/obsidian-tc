// Tests for scripts/lib/mcpb-staging.mjs (THE-951).
//
// `linkOrCopy` takes its fs calls injected, so its EXDEV fallback is tested with no filesystem at
// all — mirroring check-mcp-name.test.mjs's injected-dependency shape. `stageBundleInputs` and
// `packFromStaging` are exercised against real temp directories (mkdtemp), since what they need to
// prove — the live tree is never corrupted, and a failed pack leaves no staging directory behind
// — is a real filesystem property, not something worth mocking away.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { linkOrCopy, packFromStaging, stageBundleInputs } from "./lib/mcpb-staging.mjs";

test("linkOrCopy hardlinks when link() succeeds — copyFile is never called", async () => {
  const calls = { link: [], copyFile: [] };
  await linkOrCopy("/src/a", "/dest/a", {
    link: async (s, d) => calls.link.push([s, d]),
    copyFile: async (s, d) => calls.copyFile.push([s, d]),
  });
  assert.deepEqual(calls.link, [["/src/a", "/dest/a"]]);
  assert.deepEqual(calls.copyFile, []);
});

test("linkOrCopy falls back to a real copy on EXDEV (temp dir on another filesystem)", async () => {
  const calls = { copyFile: [] };
  await linkOrCopy("/src/a", "/dest/a", {
    link: async () => {
      const err = new Error("cross-device link");
      err.code = "EXDEV";
      throw err;
    },
    copyFile: async (s, d) => calls.copyFile.push([s, d]),
  });
  assert.deepEqual(calls.copyFile, [["/src/a", "/dest/a"]]);
});

test("linkOrCopy propagates a non-EXDEV error rather than silently copying", async () => {
  await assert.rejects(
    linkOrCopy("/src/a", "/dest/a", {
      link: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
      copyFile: async () => {
        throw new Error("copyFile must not be called for a non-EXDEV error");
      },
    }),
    /permission denied/,
  );
});

// Builds a small fixture tree shaped like the parts of the repo bundle-mcpb.ts cares about:
// a live root manifest.json (the companion plugin's Obsidian manifest, THE-950), mcpb/manifest.json
// (the MCPB bundle manifest), a .mcpbignore, and a build output file under packages/server/dist.
async function makeFixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), "mcpb-staging-fixture-"));
  await writeFile(join(root, "manifest.json"), JSON.stringify({ which: "plugin-manifest" }));
  await mkdir(join(root, "mcpb"), { recursive: true });
  await writeFile(join(root, "mcpb", "manifest.json"), JSON.stringify({ which: "mcpb-manifest" }));
  await writeFile(join(root, ".mcpbignore"), "scripts/\n**/*.ts\n");
  await mkdir(join(root, "packages", "server", "dist"), { recursive: true });
  await writeFile(join(root, "packages", "server", "dist", "cli.js"), "console.log('server');\n");
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist", "obsidian-tc.mcpb"), "stale-artifact");
  await mkdir(join(root, "node_modules", "some-dep"), { recursive: true });
  await writeFile(join(root, "node_modules", "some-dep", "index.js"), "module.exports = {};\n");
  return root;
}

test("stageBundleInputs places the MCPB manifest as manifest.json, and stages bundle inputs", async () => {
  const repoRoot = await makeFixtureRepo();
  const stagingDir = await mkdtemp(join(tmpdir(), "mcpb-staging-out-"));
  try {
    await stageBundleInputs(repoRoot, stagingDir);

    const stagedManifest = JSON.parse(await readFile(join(stagingDir, "manifest.json"), "utf8"));
    assert.deepEqual(stagedManifest, { which: "mcpb-manifest" });

    const stagedIgnore = await readFile(join(stagingDir, ".mcpbignore"), "utf8");
    assert.equal(stagedIgnore, "scripts/\n**/*.ts\n");

    const stagedCli = await readFile(
      join(stagingDir, "packages", "server", "dist", "cli.js"),
      "utf8",
    );
    assert.equal(stagedCli, "console.log('server');\n");

    for (const skipped of [".git", "dist", "node_modules"]) {
      assert.equal(existsSync(join(stagingDir, skipped)), false, `${skipped} must not be staged`);
    }

    // The live tree's own root manifest.json must be untouched — this is the property THE-951
    // exists for. It must still be the PLUGIN manifest, not overwritten by the MCPB one.
    const liveManifest = JSON.parse(await readFile(join(repoRoot, "manifest.json"), "utf8"));
    assert.deepEqual(liveManifest, { which: "plugin-manifest" });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("packFromStaging: a throwing pack leaves the live tree untouched and removes the staging dir", async () => {
  const repoRoot = await makeFixtureRepo();
  const outFile = join(repoRoot, "dist", "obsidian-tc.mcpb");
  const before = {
    manifest: await readFile(join(repoRoot, "manifest.json"), "utf8"),
    repoEntries: (await readdir(repoRoot)).sort(),
  };
  let capturedStagingDir;

  await assert.rejects(
    packFromStaging(repoRoot, outFile, {
      pack: async (stagingDir) => {
        capturedStagingDir = stagingDir;
        assert.ok(existsSync(stagingDir), "staging dir must exist while pack() runs");
        throw new Error("injected pack failure");
      },
    }),
    /injected pack failure/,
  );

  assert.ok(capturedStagingDir, "pack() must have been called with a staging dir");
  assert.equal(existsSync(capturedStagingDir), false, "staging dir must be removed after a throw");

  const after = {
    manifest: await readFile(join(repoRoot, "manifest.json"), "utf8"),
    repoEntries: (await readdir(repoRoot)).sort(),
  };
  assert.deepEqual(after, before);
  await rm(repoRoot, { recursive: true, force: true });
});

test("packFromStaging: a successful pack still removes the staging dir", async () => {
  const repoRoot = await makeFixtureRepo();
  const outFile = join(repoRoot, "dist", "obsidian-tc.mcpb");
  let capturedStagingDir;

  await packFromStaging(repoRoot, outFile, {
    pack: async (stagingDir, out) => {
      capturedStagingDir = stagingDir;
      await writeFile(out, "packed");
    },
  });

  assert.equal(existsSync(capturedStagingDir), false, "staging dir must be removed after success");
  assert.equal(await readFile(outFile, "utf8"), "packed");
  await rm(repoRoot, { recursive: true, force: true });
});
