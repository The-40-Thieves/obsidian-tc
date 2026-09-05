// Tests for scripts/mirror-plugin-release.mjs (THE-955).
//
// Every `gh` call goes through an injected fake runner — no subprocess, no network. A fake
// records every call it receives (`calls`) so a test can assert exactly which gh commands did
// or did not run, per branch.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  manifestProblems,
  mirrorPluginRelease,
  missingAssetNames,
  parseArgs,
} from "./mirror-plugin-release.mjs";

const VERSION = "1.27.0";
const SHA = "e0647616abcdef0123456789abcdef0123456789";

let workDir;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
});

function makeAssetsDir({ id = "tc-bridge", version = VERSION } = {}) {
  workDir = mkdtempSync(join(tmpdir(), "mirror-plugin-release-test-"));
  writeFileSync(join(workDir, "manifest.json"), JSON.stringify({ id, version }));
  writeFileSync(join(workDir, "main.js"), "// plugin build\n");
  writeFileSync(join(workDir, "styles.css"), "/* styles */\n");
  return workDir;
}

function notFoundError(text) {
  const err = new Error(text);
  err.stderr = text;
  return err;
}

// ---- pure helpers ----------------------------------------------------------------------------

test("manifestProblems: matching id + version passes", () => {
  assert.deepEqual(manifestProblems({ id: "tc-bridge", version: VERSION }, VERSION), []);
});

test("manifestProblems: wrong id is reported", () => {
  const problems = manifestProblems({ id: "obsidian-tc", version: VERSION }, VERSION);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /id is "obsidian-tc"/);
});

test("manifestProblems: wrong version is reported", () => {
  const problems = manifestProblems({ id: "tc-bridge", version: "1.0.0" }, VERSION);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /version is "1.0.0"/);
});

test("missingAssetNames: nothing missing when all three are present", () => {
  assert.deepEqual(missingAssetNames(["main.js", "manifest.json", "styles.css"]), []);
});

test("missingAssetNames: reports only what's absent", () => {
  assert.deepEqual(missingAssetNames(["main.js", "manifest.json"]), ["styles.css"]);
});

test("parseArgs: requires --version, --assets-dir and --sha", () => {
  assert.throws(() => parseArgs(["--version", VERSION]), /--assets-dir is required/);
});

test("parseArgs: --dry-run is optional and defaults to false", () => {
  const args = parseArgs(["--version", VERSION, "--assets-dir", "x", "--sha", SHA]);
  assert.equal(args.dryRun, false);
});

test("parseArgs: rejects an unrecognized flag", () => {
  assert.throws(() => parseArgs(["--bogus"]), /unrecognized argument/);
});

// ---- orchestration (fake runner) -------------------------------------------------------------

test("fresh path: creates the tag, creates the release with 3 assets, verifies Latest", () => {
  const dir = makeAssetsDir();
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "release" && args[1] === "view") throw notFoundError("release not found");
    if (args[0] === "api" && args[1].includes("git/ref/tags")) throw notFoundError("404 Not Found");
    if (args[0] === "api" && args[1] === "repos/{owner}/{repo}/releases/latest") {
      return `v${VERSION}\n`;
    }
    return "";
  };

  const result = mirrorPluginRelease({ version: VERSION, assetsDir: dir, sha: SHA, runner });

  assert.equal(result.action, "created");
  const cmds = calls.map((c) => c.join(" "));
  assert.ok(cmds.some((c) => c === `gh release view ${VERSION} --json assets --jq .assets[].name`));
  assert.ok(cmds.some((c) => c.includes(`git/ref/tags/${VERSION}`)));
  assert.ok(cmds.some((c) => c.includes("git/refs") && c.includes(`sha=${SHA}`)));
  assert.ok(
    cmds.some((c) => c.includes(`release create ${VERSION}`) && c.includes("--latest=false")),
  );
  assert.ok(cmds.some((c) => c.includes("releases/latest")));
});

test("already-mirrored path: no create/upload calls when all 3 assets are present", () => {
  const dir = makeAssetsDir();
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "release" && args[1] === "view") {
      return "main.js\nmanifest.json\nstyles.css\n";
    }
    throw new Error(`unexpected call in already-mirrored test: ${args.join(" ")}`);
  };

  const result = mirrorPluginRelease({ version: VERSION, assetsDir: dir, sha: SHA, runner });

  assert.equal(result.action, "already-mirrored");
  assert.equal(calls.length, 1); // only the one "release view" read
});

test("partial-assets path: uploads only the missing asset(s), never re-uploads present ones", () => {
  const dir = makeAssetsDir();
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "release" && args[1] === "view") return "main.js\nmanifest.json\n";
    return "";
  };

  const result = mirrorPluginRelease({ version: VERSION, assetsDir: dir, sha: SHA, runner });

  assert.deepEqual(result.missing, ["styles.css"]);
  const upload = calls.find((c) => c[1] === "release" && c[2] === "upload");
  assert.ok(upload, "expected a `gh release upload` call");
  assert.equal(upload.length, 5); // gh, release, upload, <version>, <one missing-asset path>
  assert.ok(upload[4].endsWith("styles.css"));
});

test("manifest mismatch: fails before any gh call", () => {
  const dir = makeAssetsDir({ id: "obsidian-tc" });
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    return "";
  };

  assert.throws(
    () => mirrorPluginRelease({ version: VERSION, assetsDir: dir, sha: SHA, runner }),
    /manifest\.json mismatch/,
  );
  assert.equal(calls.length, 0, "no gh call should run before manifest validation passes");
});

test("latest-flipped: fails after creation with a clear message", () => {
  const dir = makeAssetsDir();
  const runner = (_cmd, args) => {
    if (args[0] === "release" && args[1] === "view") throw notFoundError("release not found");
    if (args[0] === "api" && args[1].includes("git/ref/tags")) throw notFoundError("404 Not Found");
    if (args[0] === "api" && args[1] === "repos/{owner}/{repo}/releases/latest") {
      return "v1.0.0-legacy\n"; // wrong — should still be v1.27.0
    }
    return "";
  };

  assert.throws(
    () => mirrorPluginRelease({ version: VERSION, assetsDir: dir, sha: SHA, runner }),
    /Latest release is "v1\.0\.0-legacy", expected "v1\.27\.0"/,
  );
});

test("dry-run (fresh): prints the plan and issues no mutating gh call", () => {
  const dir = makeAssetsDir();
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "release" && args[1] === "view") throw notFoundError("release not found");
    if (args[0] === "api" && args[1].includes("git/ref/tags")) throw notFoundError("404 Not Found");
    return "";
  };

  const result = mirrorPluginRelease({
    version: VERSION,
    assetsDir: dir,
    sha: SHA,
    dryRun: true,
    runner,
  });

  assert.equal(result.action, "dry-run-fresh");
  // Only the two READ calls (release view, tag existence) — no "release create" or "git/refs".
  assert.equal(calls.length, 2);
  assert.ok(!calls.some((c) => c.includes("create")));
  assert.ok(!calls.some((c) => c.join(" ").includes("git/refs")));
});

test("dry-run (already-mirrored, partial): prints the plan and uploads nothing", () => {
  const dir = makeAssetsDir();
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "release" && args[1] === "view") return "main.js\nmanifest.json\n";
    return "";
  };

  const result = mirrorPluginRelease({
    version: VERSION,
    assetsDir: dir,
    sha: SHA,
    dryRun: true,
    runner,
  });

  assert.equal(result.action, "dry-run-partial");
  assert.deepEqual(result.missing, ["styles.css"]);
  assert.equal(calls.length, 1);
});
