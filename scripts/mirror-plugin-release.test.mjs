// Tests for scripts/mirror-plugin-release.mjs (THE-955).
//
// Every `gh`/`git` call goes through an injected fake runner — no subprocess, no network. A fake
// records every call it receives (`calls`) so a test can assert exactly which commands did or did
// not run, per branch.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  isPrerelease,
  manifestProblems,
  mirrorPluginRelease,
  missingAssetNames,
  parseArgs,
  readExistingRelease,
  tagExists,
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

/** A fake runner covering the standard "fresh, nothing exists yet" shape. Override per test. */
function freshRunner(calls, { latestTag = `v${VERSION}` } = {}) {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "gh" && args[0] === "release" && args[1] === "view") {
      const err = new Error("release not found");
      err.stderr = "release not found";
      throw err;
    }
    if (cmd === "git" && args[0] === "ls-remote") return ""; // tag absent
    if (cmd === "gh" && args[0] === "api" && args[1] === "repos/{owner}/{repo}/releases/latest") {
      return `${latestTag}\n`;
    }
    return "";
  };
}

// ---- pure helpers ----------------------------------------------------------------------------

test("isPrerelease: a version with a hyphen is a prerelease", () => {
  assert.equal(isPrerelease("1.28.0-rc.1"), true);
});

test("isPrerelease: a plain semver is not a prerelease", () => {
  assert.equal(isPrerelease("1.27.0"), false);
});

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

// ---- readExistingRelease: exact-match only, everything else rethrows --------------------------

test("readExistingRelease: an exact 'release not found' stderr means absent (null)", () => {
  const runner = () => {
    const err = new Error("gh exited 1");
    err.stderr = "release not found";
    throw err;
  };
  assert.equal(readExistingRelease(VERSION, runner), null);
});

test("readExistingRelease: an auth-style failure is NOT read as absent — it rethrows", () => {
  const runner = () => {
    const err = new Error("gh exited 4");
    err.stderr =
      "HTTP 404: Not Found (https://api.github.com/repos/the-40-thieves/obsidian-tc/releases/tags/1.27.0)\n" +
      "gh: to authenticate, run `gh auth login`";
    throw err;
  };
  assert.throws(
    () => readExistingRelease(VERSION, runner),
    (err) => /HTTP 404/.test(err.stderr),
  );
});

test("readExistingRelease: a plain 'not found' substring that ISN'T the exact message rethrows", () => {
  const runner = () => {
    const err = new Error("boom");
    err.stderr = "organization SSO required — not found or access denied";
    throw err;
  };
  assert.throws(
    () => readExistingRelease(VERSION, runner),
    (err) => /organization SSO/.test(err.stderr),
  );
});

// ---- tagExists: git ls-remote, not a gh 404 regex ----------------------------------------------

test("tagExists: non-empty ls-remote output means the tag exists", () => {
  const runner = () => `${SHA}\trefs/tags/${VERSION}\n`;
  assert.equal(tagExists(VERSION, runner), true);
});

test("tagExists: empty ls-remote output means the tag is absent", () => {
  const runner = () => "";
  assert.equal(tagExists(VERSION, runner), false);
});

test("tagExists: a runner failure (network/auth) propagates — never read as absent", () => {
  const runner = () => {
    throw new Error("could not resolve host");
  };
  assert.throws(() => tagExists(VERSION, runner), /could not resolve host/);
});

// ---- orchestration (fake runner) -------------------------------------------------------------

test("prerelease: skips entirely, exits with no gh/git call at all", () => {
  const dir = makeAssetsDir({ version: "1.28.0-rc.1" });
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    return "";
  };

  const result = mirrorPluginRelease({
    version: "1.28.0-rc.1",
    assetsDir: dir,
    sha: SHA,
    runner,
  });

  assert.equal(result.action, "skipped-prerelease");
  assert.equal(calls.length, 0, "a prerelease must do nothing — no gh/git call at all");
});

test("prerelease: also skips in --dry-run", () => {
  const dir = makeAssetsDir({ version: "1.28.0-rc.1" });
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    return "";
  };
  const result = mirrorPluginRelease({
    version: "1.28.0-rc.1",
    assetsDir: dir,
    sha: SHA,
    dryRun: true,
    runner,
  });
  assert.equal(result.action, "skipped-prerelease");
  assert.equal(calls.length, 0);
});

test("fresh path: creates the tag via git ls-remote check, creates the release with 3 assets, verifies Latest", () => {
  const dir = makeAssetsDir();
  const calls = [];
  const runner = freshRunner(calls);

  const result = mirrorPluginRelease({ version: VERSION, assetsDir: dir, sha: SHA, runner });

  assert.equal(result.action, "created");
  const cmds = calls.map((c) => c.join(" "));
  assert.ok(cmds.some((c) => c === `gh release view ${VERSION} --json assets --jq .assets[].name`));
  assert.ok(cmds.some((c) => c === `git ls-remote --tags origin refs/tags/${VERSION}`));
  assert.ok(cmds.some((c) => c.includes("git/refs") && c.includes(`sha=${SHA}`)));
  assert.ok(
    cmds.some((c) => c.includes(`release create ${VERSION}`) && c.includes("--latest=false")),
  );
  assert.ok(cmds.some((c) => c.includes("releases/latest")));
});

test("fresh path: reuses an existing tag instead of re-creating it", () => {
  const dir = makeAssetsDir();
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "gh" && args[0] === "release" && args[1] === "view") {
      const err = new Error("release not found");
      err.stderr = "release not found";
      throw err;
    }
    if (cmd === "git" && args[0] === "ls-remote") return `${SHA}\trefs/tags/${VERSION}\n`; // present
    if (cmd === "gh" && args[0] === "api" && args[1] === "repos/{owner}/{repo}/releases/latest") {
      return `v${VERSION}\n`;
    }
    return "";
  };

  const result = mirrorPluginRelease({ version: VERSION, assetsDir: dir, sha: SHA, runner });

  assert.equal(result.action, "created");
  assert.ok(
    !calls.some((c) => c.join(" ").includes("git/refs")),
    "must not re-create an existing tag",
  );
});

test("already-mirrored path: no create/upload calls, but the Latest check still runs", () => {
  const dir = makeAssetsDir();
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "gh" && args[0] === "release" && args[1] === "view") {
      return "main.js\nmanifest.json\nstyles.css\n";
    }
    if (cmd === "gh" && args[0] === "api" && args[1] === "repos/{owner}/{repo}/releases/latest") {
      return `v${VERSION}\n`;
    }
    throw new Error(`unexpected call in already-mirrored test: ${cmd} ${args.join(" ")}`);
  };

  const result = mirrorPluginRelease({ version: VERSION, assetsDir: dir, sha: SHA, runner });

  assert.equal(result.action, "already-mirrored");
  assert.equal(calls.length, 2, "release view + the unconditional Latest check, nothing else");
  assert.ok(!calls.some((c) => c.join(" ").includes("upload")));
  assert.ok(!calls.some((c) => c.join(" ").includes("create")));
});

test("already-mirrored path goes RED when Latest is the mirror, not v<version> (fix round 1, review finding 2)", () => {
  const dir = makeAssetsDir();
  const runner = (cmd, args) => {
    if (cmd === "gh" && args[0] === "release" && args[1] === "view") {
      return "main.js\nmanifest.json\nstyles.css\n";
    }
    if (cmd === "gh" && args[0] === "api" && args[1] === "repos/{owner}/{repo}/releases/latest") {
      return `${VERSION}\n`; // WRONG: the un-prefixed mirror itself, not v<version>
    }
    return "";
  };

  assert.throws(
    () => mirrorPluginRelease({ version: VERSION, assetsDir: dir, sha: SHA, runner }),
    /Latest release is "1\.27\.0" — the un-prefixed mirror release itself.*action: "already-mirrored"/s,
  );
});

test("already-mirrored path PASSES when Latest is a NEWER stable release (fix round 2 — narrower invariant)", () => {
  // Exact reviewer scenario: re-running v1.28.0's mirror job after v1.28.1 has already shipped.
  // Latest correctly points at v1.28.1 (a later release, not the mirror) — that must be a pass,
  // not a permanent failure just because it differs from v<version>.
  const dir = makeAssetsDir({ version: "1.28.0" });
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "gh" && args[0] === "release" && args[1] === "view") {
      return "main.js\nmanifest.json\nstyles.css\n";
    }
    if (cmd === "gh" && args[0] === "api" && args[1] === "repos/{owner}/{repo}/releases/latest") {
      return "v1.28.1\n"; // a LATER release, not v1.28.0 and not the "1.28.0" mirror itself
    }
    return "";
  };

  const result = mirrorPluginRelease({ version: "1.28.0", assetsDir: dir, sha: SHA, runner });

  assert.equal(result.action, "already-mirrored");
  assert.ok(calls.some((c) => c.join(" ").includes("releases/latest")));
});

test("partial-assets path: uploads only the missing asset(s), then still verifies Latest", () => {
  const dir = makeAssetsDir();
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "gh" && args[0] === "release" && args[1] === "view")
      return "main.js\nmanifest.json\n";
    if (cmd === "gh" && args[0] === "api" && args[1] === "repos/{owner}/{repo}/releases/latest") {
      return `v${VERSION}\n`;
    }
    return "";
  };

  const result = mirrorPluginRelease({ version: VERSION, assetsDir: dir, sha: SHA, runner });

  assert.deepEqual(result.missing, ["styles.css"]);
  const upload = calls.find((c) => c[1] === "release" && c[2] === "upload");
  assert.ok(upload, "expected a `gh release upload` call");
  assert.equal(upload.length, 5); // gh, release, upload, <version>, <one missing-asset path>
  assert.ok(upload[4].endsWith("styles.css"));
  assert.ok(calls.some((c) => c.join(" ").includes("releases/latest")));
});

test("manifest mismatch: fails before any gh/git call", () => {
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
  assert.equal(calls.length, 0, "no gh/git call should run before manifest validation passes");
});

test("fresh path: fails only when the newly created release ITSELF becomes Latest", () => {
  const dir = makeAssetsDir();
  const runner = (_cmd, args) => {
    if (args[0] === "release" && args[1] === "view") {
      const err = new Error("release not found");
      err.stderr = "release not found";
      throw err;
    }
    if (args[0] === "ls-remote") return "";
    if (args[0] === "api" && args[1] === "repos/{owner}/{repo}/releases/latest") {
      return `${VERSION}\n`; // WRONG: the mirror itself, not v<version> or anything else
    }
    return "";
  };

  assert.throws(
    () => mirrorPluginRelease({ version: VERSION, assetsDir: dir, sha: SHA, runner }),
    /Latest release is "1\.27\.0" — the un-prefixed mirror release itself/,
  );
});

test("fresh path: PASSES when Latest is an unrelated older v-tag, not just v<version> exactly (fix round 2)", () => {
  const dir = makeAssetsDir();
  const runner = (_cmd, args) => {
    if (args[0] === "release" && args[1] === "view") {
      const err = new Error("release not found");
      err.stderr = "release not found";
      throw err;
    }
    if (args[0] === "ls-remote") return "";
    if (args[0] === "api" && args[1] === "repos/{owner}/{repo}/releases/latest") {
      return "v1.0.0-legacy\n"; // some other real tag — not v1.27.0, and not the 1.27.0 mirror
    }
    return "";
  };

  const result = mirrorPluginRelease({ version: VERSION, assetsDir: dir, sha: SHA, runner });
  assert.equal(result.action, "created");
});

test("dry-run (fresh): prints the plan and issues no mutating gh/git call", () => {
  const dir = makeAssetsDir();
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "gh" && args[0] === "release" && args[1] === "view") {
      const err = new Error("release not found");
      err.stderr = "release not found";
      throw err;
    }
    if (cmd === "git" && args[0] === "ls-remote") return "";
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
  // Only the two READ calls (release view, tag existence) — no "release create" or "git/refs",
  // and no Latest check either (dry-run reports the plan, it doesn't assert post-conditions).
  assert.equal(calls.length, 2);
  assert.ok(!calls.some((c) => c.includes("create")));
  assert.ok(!calls.some((c) => c.join(" ").includes("git/refs")));
});

test("dry-run (already-mirrored, partial): prints the plan and uploads nothing", () => {
  const dir = makeAssetsDir();
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "gh" && args[0] === "release" && args[1] === "view")
      return "main.js\nmanifest.json\n";
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
