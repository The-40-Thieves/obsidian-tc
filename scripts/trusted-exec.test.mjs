// Tests for scripts/lib/trusted-exec.mjs: which PATH directories a repository script may take an
// executable from. Everything is injected (PATH, platform, filesystem), so no process is started
// and the same cases run on every OS.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { nodeExecutable, resolveExecutable, trustedExecutable } from "./lib/trusted-exec.mjs";

const FILE = 0o100755;
const PLAIN = 0o100644;
const DIR = 0o040755;
const OPEN_DIR = 0o040777;

/** A fake filesystem: path -> mode. `sep` picks the platform's separator for the lookups. */
function host(platform, entries, pathDirs, extra = {}) {
  const win = platform === "win32";
  const norm = (p) => (win ? p.toLowerCase() : p);
  const table = new Map(Object.entries(entries).map(([p, mode]) => [norm(p), mode]));
  return {
    platform,
    repoRoot: win ? "C:\\repo" : "/repo",
    env: { PATH: pathDirs.join(win ? ";" : ":") },
    stat: (p) => {
      const mode = table.get(norm(p));
      if (mode === undefined) return null;
      return {
        mode,
        isFile: () => (mode & 0o170000) === 0o100000,
        isDirectory: () => (mode & 0o170000) === 0o040000,
      };
    },
    ...extra,
  };
}

test("takes the first match from an ordinary system directory", () => {
  const h = host(
    "linux",
    { "/usr/bin": DIR, "/usr/bin/git": FILE, "/opt/x": DIR, "/opt/x/git": FILE },
    ["/usr/bin", "/opt/x"],
  );
  assert.equal(resolveExecutable("git", h), "/usr/bin/git");
});

test("skips a relative or empty PATH entry, the classic current-directory hijack", () => {
  const h = host("linux", { "/usr/bin": DIR, "/usr/bin/git": FILE, "bin/git": FILE, git: FILE }, [
    "",
    ".",
    "bin",
    "/usr/bin",
  ]);
  assert.equal(resolveExecutable("git", h), "/usr/bin/git");
});

test("skips directories inside the repository, such as node_modules/.bin", () => {
  const h = host(
    "linux",
    {
      "/repo/node_modules/.bin": DIR,
      "/repo/node_modules/.bin/git": FILE,
      "/usr/bin": DIR,
      "/usr/bin/git": FILE,
    },
    ["/repo/node_modules/.bin", "/usr/bin"],
  );
  assert.equal(resolveExecutable("git", h), "/usr/bin/git");
  const only = host("linux", { "/repo/tools": DIR, "/repo/tools/git": FILE }, ["/repo/tools"]);
  assert.equal(resolveExecutable("git", only), null);
});

test("a sibling whose name merely starts with the repository's is not inside it", () => {
  const h = host("linux", { "/repo-tools": DIR, "/repo-tools/git": FILE }, ["/repo-tools"]);
  assert.equal(resolveExecutable("git", h), "/repo-tools/git");
});

test("does not judge directory permissions: a hosted runner's mode-777 tool cache is used", () => {
  const h = host(
    "linux",
    {
      "/opt/hostedtoolcache/node/bin": OPEN_DIR,
      "/opt/hostedtoolcache/node/bin/node": FILE,
      "/usr/local/bin": DIR,
      "/usr/local/bin/node": FILE,
    },
    ["/opt/hostedtoolcache/node/bin", "/usr/local/bin"],
  );
  assert.equal(resolveExecutable("node", h), "/opt/hostedtoolcache/node/bin/node");
});

test("nodeExecutable is the running node binary, with no PATH lookup", () => {
  assert.equal(nodeExecutable(), process.execPath);
});

test("needs a regular file with an execute bit on POSIX", () => {
  const h = host(
    "linux",
    {
      "/a": DIR,
      "/a/git": DIR,
      "/b": DIR,
      "/b/git": PLAIN,
      "/c": DIR,
      "/c/git": FILE,
    },
    ["/a", "/b", "/c"],
  );
  assert.equal(resolveExecutable("git", h), "/c/git");
});

test("on Windows it matches .exe and .com, never a .cmd shim, and ignores case", () => {
  const h = host(
    "win32",
    {
      "C:\\shims": DIR,
      "C:\\shims\\rg.cmd": PLAIN,
      "C:\\Tools": DIR,
      "C:\\Tools\\rg.exe": PLAIN,
      "C:\\REPO\\node_modules\\.bin": DIR,
      "C:\\REPO\\node_modules\\.bin\\rg.exe": PLAIN,
    },
    ["C:\\REPO\\node_modules\\.bin", "C:\\shims", "C:\\Tools"],
    { env: { Path: "C:\\REPO\\node_modules\\.bin;C:\\shims;C:\\Tools" } },
  );
  assert.equal(resolveExecutable("rg", h), "C:\\Tools\\rg.exe");
});

test("refuses anything that is not a bare command name", () => {
  const h = host("linux", { "/usr/bin": DIR, "/usr/bin/git": FILE }, ["/usr/bin"]);
  for (const bad of ["", "../git", "/usr/bin/git", "a/b", "a\\b", "git --version"])
    assert.throws(() => resolveExecutable(bad, h), /bare command name/, bad);
});

test("trustedExecutable throws an ENOENT-coded error that names the command", () => {
  const h = host("linux", { "/usr/bin": DIR }, ["/usr/bin"]);
  assert.throws(
    () => trustedExecutable("shellcheck", h),
    (e) => e.code === "ENOENT" && /shellcheck/.test(e.message),
  );
  const ok = host("linux", { "/usr/bin": DIR, "/usr/bin/git": FILE }, ["/usr/bin"]);
  assert.equal(trustedExecutable("git", ok), "/usr/bin/git");
});

test("on this machine it finds node's own directory entry as an absolute path", () => {
  const found = resolveExecutable("node");
  if (found !== null) assert.match(found, /^([A-Za-z]:\\|\/)/);
});

// A caller that uses the resolver without importing it only fails when that line runs, and most of
// these scripts have no test of their own. One was shipped with the import inside a template
// string, so check the import is a real one: nothing but imports and comments may come before it.
test("every script that calls the resolver imports it at the top of the module", () => {
  const root = new URL("..", import.meta.url);
  const files = execFileSync(
    trustedExecutable("git"),
    ["ls-files", "scripts", "packages/server/scripts", "packages/server/eval"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter((f) => f.endsWith(".mjs") || f.endsWith(".ts"))
    .filter((f) => !f.endsWith("trusted-exec.mjs") && !f.endsWith("trusted-exec.test.mjs"));
  const callers = [];
  for (const file of files) {
    const lines = readFileSync(new URL(file, root), "utf8").split("\n");
    if (!lines.some((l) => l.includes("trustedExecutable(") || l.includes("nodeExecutable(")))
      continue;
    callers.push(file);
    let imported = false;
    let inImport = false;
    for (const line of lines) {
      const t = line.trim();
      if (inImport) {
        if (t.includes("trusted-exec.mjs")) imported = true;
        if (t.endsWith(";")) inImport = false;
        continue;
      }
      if (t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) continue;
      if (t.startsWith("#!")) continue;
      if (!t.startsWith("import ")) break;
      if (t.includes("trusted-exec.mjs")) imported = true;
      if (!t.endsWith(";")) inImport = true;
    }
    assert.ok(imported, `${file} calls the resolver but does not import it at the top`);
  }
  assert.ok(callers.length >= 30, `expected the known callers, found ${callers.length}`);
});
