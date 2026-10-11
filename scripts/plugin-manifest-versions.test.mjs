// The Claude Code and Muse Code plugin files join the lockstep release set: one inventory
// (scripts/lib/plugin-manifest-versions.mjs) that BOTH release.mjs (writes) and
// check-version-coherence.mjs (asserts) read, so a release cannot bump one and forget the other.
// Carriers: each manifest's `version`, plus the exact npm version each launcher pins (Anthropic's
// plugin directory blocks an unpinned `npx`).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  PLUGIN_MANIFEST_PATHS,
  PLUGIN_MCP_JSON,
  pinnedPackageSpec,
  pluginManifestVersionSources,
} from "./lib/plugin-manifest-versions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const text = (p) => readFileSync(join(ROOT, p), "utf8");

const fake = (v) => (p) =>
  p === PLUGIN_MCP_JSON
    ? { mcpServers: { "obsidian-tc": { args: ["-y", pinnedPackageSpec("obsidian-tc", v)] } } }
    : {
        version: v,
        capabilities: {
          mcpServers: [{ command: ["npx", "-y", pinnedPackageSpec("obsidian-tc", v)] }],
        },
      };

test("the inventory names both plugin manifests and the shared .mcp.json", () => {
  assert.deepEqual(
    [...PLUGIN_MANIFEST_PATHS],
    [
      "plugins/obsidian-tc/.claude-plugin/plugin.json",
      "plugins/obsidian-tc/.muse-plugin/plugin.json",
    ],
  );
  assert.equal(PLUGIN_MCP_JSON, "plugins/obsidian-tc/.mcp.json");
});

test("sources carry the manifest versions AND both launcher pins, all labelled", () => {
  const sources = pluginManifestVersionSources(fake("9.9.9"));
  assert.equal(sources.length, 4);
  for (const s of sources) assert.equal(s.version, "9.9.9", s.label);
  assert.deepEqual(
    sources.map((s) => s.label),
    [
      ...PLUGIN_MANIFEST_PATHS,
      `${PLUGIN_MCP_JSON} launcher pin`,
      `${PLUGIN_MANIFEST_PATHS[1]} launcher pin`,
    ],
  );
});

test("a missing manifest field or an unpinned launcher surfaces as undefined, which the gate rejects", () => {
  const sources = pluginManifestVersionSources(() => ({}));
  assert.ok(sources.every((s) => s.version === undefined));
  const unpinned = pluginManifestVersionSources((p) =>
    p === PLUGIN_MCP_JSON
      ? { mcpServers: { "obsidian-tc": { args: ["-y", "obsidian-tc"] } } }
      : fake("1.0.0")(p),
  );
  assert.equal(unpinned.find((s) => s.label.startsWith(PLUGIN_MCP_JSON)).version, undefined);
});

test("release.mjs rewrites the launcher pins, not just the manifests", () => {
  const r = text("scripts/release.mjs");
  assert.match(r, /PLUGIN_MCP_JSON/);
  assert.match(r, /pinnedPackageSpec/);
});

test("check-version-coherence.mjs and release.mjs both consume the shared inventory", () => {
  for (const f of ["scripts/check-version-coherence.mjs", "scripts/release.mjs"]) {
    assert.match(text(f), /lib\/plugin-manifest-versions\.mjs/, `${f} must import the inventory`);
  }
  assert.match(text("scripts/check-version-coherence.mjs"), /pluginManifestVersionSources/);
  assert.match(text("scripts/release.mjs"), /PLUGIN_MANIFEST_PATHS/);
});

test("end to end: a drifted manifest version or launcher pin fails check-version-coherence", () => {
  const dir = mkdtempSync(join(tmpdir(), "otc-ver-"));
  try {
    // copy exactly the files the gate reads, then drift one at a time
    const files = [
      "package.json",
      "packages/server/package.json",
      "packages/native/package.json",
      "packages/shared/package.json",
      "packages/reranker-local/package.json",
      "packages/embedder-local/package.json",
      "packages/plugin/package.json",
      "packages/plugin/manifest.json",
      "packages/plugin/versions.json",
      "manifest.json",
      "server.json",
      "mcpb/manifest.json",
      "bun.lock",
      "README.md",
      "packages/server/README.md",
      "docs/src/content/docs/index.md",
      "docs/src/content/docs/roadmap.md",
      "docs/wiki/Home.md",
      "SECURITY.md",
      ...PLUGIN_MANIFEST_PATHS,
      PLUGIN_MCP_JSON,
    ];
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), text(f));
    }
    const run = () =>
      spawnSync("node", [join(ROOT, "scripts/check-version-coherence.mjs")], {
        cwd: dir,
        encoding: "utf8",
      });
    assert.equal(run().status, 0, "baseline copy must pass");

    const museFile = join(dir, PLUGIN_MANIFEST_PATHS[1]);
    const drifted = JSON.parse(text(PLUGIN_MANIFEST_PATHS[1]));
    drifted.version = "0.0.1";
    writeFileSync(museFile, JSON.stringify(drifted));
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /version drift/);
    assert.match(r.stdout, /muse-plugin\/plugin\.json\s+0\.0\.1/);

    // restore the manifest, then drift ONLY the .mcp.json launcher pin
    writeFileSync(museFile, text(PLUGIN_MANIFEST_PATHS[1]));
    writeFileSync(
      join(dir, PLUGIN_MCP_JSON),
      text(PLUGIN_MCP_JSON).replace(/obsidian-tc@[\d.]+/, "obsidian-tc@0.0.2"),
    );
    const r2 = run();
    assert.equal(r2.status, 1);
    assert.match(r2.stdout, /\.mcp\.json launcher pin\s+0\.0\.2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
