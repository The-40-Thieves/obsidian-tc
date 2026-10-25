import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

function walkYaml(dir, out = []) {
  for (const name of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${name.name}`;
    if (name.isDirectory()) walkYaml(rel, out);
    else if (name.name.endsWith(".yml") || name.name.endsWith(".yaml")) out.push(rel);
  }
  return out;
}

const WORKFLOW_FILES = walkYaml(".github");
const DOCKERFILES = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter((f) => /(^|\/)Dockerfile[^/]*$/.test(f));

/**
 * Logical shell lines of a file: comment lines dropped, backslash continuations joined. A `run:`
 * block is one line per source line, which is what the checks need.
 */
function commandLines(text) {
  const out = [];
  let buf = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (buf === null && line.startsWith("#")) continue;
    buf = buf === null ? line : `${buf} ${line}`;
    if (buf.endsWith("\\")) {
      buf = buf.slice(0, -1);
      continue;
    }
    out.push(buf);
    buf = null;
  }
  return out;
}

/** Each occurrence of `re` in `cmd`, as the text from that occurrence to the next `&&`/`;`/`|`. */
function segmentsOf(cmd, re) {
  const segs = [];
  for (const m of cmd.matchAll(new RegExp(re.source, "g"))) {
    const rest = cmd.slice(m.index);
    const end = rest.search(/&&|\|\||;|\|/);
    segs.push((end === -1 ? rest : rest.slice(0, end)).trim());
  }
  return segs;
}

/** `- run: x` and `run: x` are the same step line for these checks. */
const normalize = (line) => line.replace(/^-\s+/, "");

// ---- item 4: every curl carries --proto '=https' ------------------------------------------------

/**
 * Curl invocations allowed WITHOUT the flag. Only a probe against localhost qualifies: it is not a
 * download, so there is no redirect to a foreign host to force HTTPS on. Empty today: no workflow
 * probes localhost.
 */
const CURL_LOCALHOST_PROBE_ALLOWLIST = new Set([]);

test("curl: every curl in .github carries --proto '=https' (localhost probes allowlisted)", () => {
  const sites = [];
  const failures = [];
  for (const file of WORKFLOW_FILES) {
    for (const cmd of commandLines(read(file))) {
      if (!/(^|[\s;&|(])curl\s/.test(cmd)) continue;
      sites.push(`${file}: ${cmd}`);
      if (cmd.includes("--proto '=https'")) continue;
      if ([...CURL_LOCALHOST_PROBE_ALLOWLIST].some((probe) => cmd.includes(probe))) continue;
      failures.push(`${file}: ${cmd}`);
    }
  }
  assert.ok(sites.length >= 14, `expected to scan every curl, saw ${sites.length}`);
  assert.deepEqual(failures, [], "curl without --proto '=https'");
});

// ---- item 5: every bun install ignores lifecycle scripts, or is allowlisted with a reason ------

/**
 * Installs that run lifecycle scripts on purpose. Each entry is `file` + the exact normalised line,
 * matched once per occurrence.
 */
const BUN_INSTALL_ALLOWLIST = [
  {
    file: ".github/actions/setup-repo/action.yml",
    text: "bun install --frozen-lockfile",
    reason:
      "the documented install-mode: frozen opt-in (lifecycle scripts on); no caller uses it after the item-5 change",
  },
  {
    file: ".github/workflows/ci-install-smoke.yml",
    text: "bun install --frozen-lockfile",
    reason:
      "case (c): this job exists to exercise the real install path (lifecycle scripts included), so it must not be softened",
  },
];

test("bun install: every install in .github and the Dockerfiles ignores lifecycle scripts, or is allowlisted", () => {
  const unignored = [];
  let scanned = 0;
  for (const file of [...WORKFLOW_FILES, ...DOCKERFILES]) {
    for (const cmd of commandLines(read(file))) {
      if (/^(-\s+)?name:/.test(cmd)) continue; // a step title such as "cache bun install"
      for (const seg of segmentsOf(cmd, /\bbun install\b/)) {
        // Prose such as a YAML description that mentions "bun install" is not a command.
        if (!/^bun install(\s+--?[\w-]+)*$/.test(seg)) continue;
        scanned++;
        if (seg.includes("--ignore-scripts")) continue;
        unignored.push(`${file} :: ${normalize(seg)}`);
      }
    }
  }
  const allowed = BUN_INSTALL_ALLOWLIST.map((e) => `${e.file} :: ${e.text}`);
  assert.ok(scanned >= 20, `expected to scan every bun install, saw ${scanned}`);
  assert.deepEqual(unignored.sort(), allowed.sort(), "bun installs without --ignore-scripts");
});

// ---- item 6: pip installs are hash-locked or pin every package --------------------------------

/** Installs that are neither hash-locked nor pinned, each with a reason. */
const PIP_INSTALL_ALLOWLIST = [
  {
    file: ".github/workflows/ci-model-service.yml",
    text: "pip install --no-deps -e .",
    reason:
      "installs this repo's own package with --no-deps; only its build backend resolves from an index",
  },
];

const PINNED = /^[A-Za-z0-9_.-]+(\[[A-Za-z0-9_,.-]+\])?==[^\s=]+$/;

test("pip install: every install in .github is --require-hashes or pins each package with ==", () => {
  const unpinned = [];
  let scanned = 0;
  for (const file of WORKFLOW_FILES) {
    for (const cmd of commandLines(read(file))) {
      for (const seg of segmentsOf(cmd, /\bpip install\b/)) {
        if (!/^pip install(\s+\S+)*$/.test(seg)) continue;
        scanned++;
        if (seg.includes("--require-hashes")) continue;
        const args = seg.split(/\s+/).slice(2); // drop "pip" "install"
        const pkgs = args.filter((a) => !a.startsWith("-"));
        const flagsTakingValue = args.some((a) => a === "-r" || a === "-e" || a === "--editable");
        const ok = !flagsTakingValue && pkgs.length > 0 && pkgs.every((p) => PINNED.test(p));
        if (!ok) unpinned.push(`${file} :: ${seg}`);
      }
    }
  }
  const allowed = PIP_INSTALL_ALLOWLIST.map((e) => `${e.file} :: ${e.text}`);
  assert.ok(scanned >= 9, `expected to scan every pip install, saw ${scanned}`);
  assert.deepEqual(
    unpinned.sort(),
    allowed.sort(),
    "pip installs that are neither hashed nor pinned",
  );
});
