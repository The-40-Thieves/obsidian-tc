// Tests for scripts/check-vault-leak.mjs.
//
// The guard is a top-level script over `git ls-files`, so each case builds a throwaway repo from
// SYNTHETIC files (never real vault data), runs the script with that repo as cwd, and reads the exit code
// and output. The incident the guard exists for: a private golden set plus a vault index were committed
// to this public repo. A guard tested only on cases its author invented passes the shapes nobody hit, so
// the cases below are the shapes that slipped past the first version: a JSON golden set with quoted keys,
// a golden file dressed up as a registered corpus, and a real note path that is not `NN-folder/` shaped.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-vault-leak.mjs");
const REPO_ROOT = join(dirname(SCRIPT), "..");
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

const GOLDEN_DIR = "packages/server/eval/corpora/golden";
const REGISTRY = "packages/server/eval/corpora/corpora.json";
const PUBLIC_ENTRY = {
  kind: "github",
  licence: "MIT",
  repo: "example-org/example-docs",
  commit: "0123456789abcdef0123456789abcdef01234567",
};
const GOLDEN_JSON = `{\n  "queries": [\n    {\n      "id": "x-1",\n      "seed_paths": [\n        "a/b.md"\n      ],\n      "target_paths": [],\n      "bridge_paths": []\n    }\n  ]\n}\n`;

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A repo whose tracked files are exactly `files` (path -> text). */
function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), "vault-leak-"));
  dirs.push(dir);
  writeTree(dir, files);
  const git = (...a) => execFileSync("git", a, { cwd: dir, env: GIT_ENV, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  return dir;
}

function writeTree(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
}

/** A directory that is NOT a repo, used as the fixture vault. */
function makeVault(notes) {
  const dir = mkdtempSync(join(tmpdir(), "vault-leak-vault-"));
  dirs.push(dir);
  writeTree(dir, Object.fromEntries(notes.map((n) => [n, "# synthetic\n"])));
  return dir;
}

const run = (cwd, ...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: GIT_ENV, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

const registry = (corpora) => JSON.stringify({ corpora }, null, 2);

// ── structural: golden-set shape ────────────────────────────────────────────────────────────────────

test("a clean tree passes the structural check", () => {
  const dir = makeRepo({ "README.md": "hello\n" });
  assert.equal(run(dir).code, 0);
});

test("RED: a JSON golden set with quoted keys outside eval/corpora/golden fails", () => {
  const dir = makeRepo({ "data/private-golden.json": GOLDEN_JSON });
  const r = run(dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[golden-set-shape\] data\/private-golden\.json:\d+/);
});

test("RED: a minified one-line JSON golden set fails", () => {
  const dir = makeRepo({ "fixtures/q.json": '{"queries":[{"id":"1","seed_paths":["a.md"]}]}\n' });
  assert.equal(run(dir).code, 1);
});

test("RED: a YAML golden set with QUOTED keys fails", () => {
  const dir = makeRepo({ "data/q.yaml": 'queries:\n  - "target_paths":\n      - "a.md"\n' });
  assert.equal(run(dir).code, 1);
});

test("a YAML golden set with unquoted keys still fails", () => {
  const dir = makeRepo({ "data/q.yaml": "queries:\n  - id: 1\n    bridge_paths:\n      - a.md\n" });
  assert.equal(run(dir).code, 1);
});

test("a golden-set-named JSON file fails even without the keys", () => {
  const dir = makeRepo({ "golden-set.json": "{}\n" });
  assert.equal(run(dir).code, 1);
});

test("a schema declaration in source is not golden-set data", () => {
  const dir = makeRepo({ "src/metrics.ts": "const s = { seed_paths: z.array(z.string()) };\n" });
  assert.equal(run(dir).code, 0);
});

test("a synthetic .example.yaml golden set is allowed", () => {
  const dir = makeRepo({
    "somewhere/synthetic-multihop.example.yaml":
      "queries:\n  - id: a\n    seed_paths:\n      - x/y.md\n",
  });
  assert.equal(run(dir).code, 0);
});

test("RED: a golden JSON for a corpus id NOT in corpora.json fails", () => {
  const dir = makeRepo({
    [`${GOLDEN_DIR}/unregistered.json`]: GOLDEN_JSON,
    [REGISTRY]: registry({ "some-other-corpus": PUBLIC_ENTRY }),
  });
  const r = run(dir);
  assert.equal(r.code, 1, r.out);
  assert.match(
    r.out,
    /\[golden-set-shape\] packages\/server\/eval\/corpora\/golden\/unregistered\.json/,
  );
});

test("a golden JSON for a registered corpus with a pinned public source and licence is allowed", () => {
  const dir = makeRepo({
    [`${GOLDEN_DIR}/quartz-docs.json`]: GOLDEN_JSON,
    [REGISTRY]: registry({ "quartz-docs": PUBLIC_ENTRY }),
  });
  const r = run(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 registered public golden set/);
});

test("RED: a registered corpus with no pinned commit does not unlock its golden JSON", () => {
  const { commit: _c, ...unpinned } = PUBLIC_ENTRY;
  const dir = makeRepo({
    [`${GOLDEN_DIR}/quartz-docs.json`]: GOLDEN_JSON,
    [REGISTRY]: registry({ "quartz-docs": unpinned }),
  });
  assert.equal(run(dir).code, 1);
});

test("RED: a registered corpus with a branch name instead of a commit does not unlock", () => {
  const dir = makeRepo({
    [`${GOLDEN_DIR}/quartz-docs.json`]: GOLDEN_JSON,
    [REGISTRY]: registry({ "quartz-docs": { ...PUBLIC_ENTRY, commit: "main" } }),
  });
  assert.equal(run(dir).code, 1);
});

test("RED: a registered corpus with no licence does not unlock its golden JSON", () => {
  const { licence: _l, ...unlicensed } = PUBLIC_ENTRY;
  const dir = makeRepo({
    [`${GOLDEN_DIR}/quartz-docs.json`]: GOLDEN_JSON,
    [REGISTRY]: registry({ "quartz-docs": unlicensed }),
  });
  assert.equal(run(dir).code, 1);
});

test("RED: a registered corpus with no public repo does not unlock its golden JSON", () => {
  const { repo: _r, ...norepo } = PUBLIC_ENTRY;
  const dir = makeRepo({
    [`${GOLDEN_DIR}/quartz-docs.json`]: GOLDEN_JSON,
    [REGISTRY]: registry({ "quartz-docs": norepo }),
  });
  assert.equal(run(dir).code, 1);
});

test("RED: a golden JSON with no corpora.json at all fails", () => {
  const dir = makeRepo({ [`${GOLDEN_DIR}/quartz-docs.json`]: GOLDEN_JSON });
  assert.equal(run(dir).code, 1);
});

test("RED: a corpora.json that does not parse unlocks nothing and is reported", () => {
  const dir = makeRepo({
    [`${GOLDEN_DIR}/quartz-docs.json`]: GOLDEN_JSON,
    [REGISTRY]: "{ not json",
  });
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /corpora-registry/);
});

test("RED: the registered id must be the file stem, in the golden dir itself", () => {
  const nested = makeRepo({
    [`${GOLDEN_DIR}/sub/quartz-docs.json`]: GOLDEN_JSON,
    [REGISTRY]: registry({ "quartz-docs": PUBLIC_ENTRY }),
  });
  assert.equal(run(nested).code, 1);
  const elsewhere = makeRepo({
    "packages/server/eval/quartz-docs.json": GOLDEN_JSON,
    [REGISTRY]: registry({ "quartz-docs": PUBLIC_ENTRY }),
  });
  assert.equal(run(elsewhere).code, 1);
});

test("RED: a registered id does not unlock a YAML golden set in the golden dir", () => {
  const dir = makeRepo({
    [`${GOLDEN_DIR}/quartz-docs.yaml`]: "queries:\n  - seed_paths:\n      - a.md\n",
    [REGISTRY]: registry({ "quartz-docs": PUBLIC_ENTRY }),
  });
  assert.equal(run(dir).code, 1);
});

test("the committed tree passes the structural check, with its registered golden sets counted", () => {
  const r = run(REPO_ROOT);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /[1-9]\d* registered public golden sets?/);
});

// ── deep: real note paths in any shape ──────────────────────────────────────────────────────────────

test("RED: a real note path that is not NN-folder shaped is caught in deep mode", () => {
  const vault = makeVault(["Notes/Some Private Note.md", "Notes/Other.md"]);
  const dir = makeRepo({ "docs/leak.md": "line one\nsee `Notes/Some Private Note.md` here\n" });
  const r = run(dir, "--vault", vault);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[REAL-NOTE\] docs\/leak\.md:2/);
});

test("deep mode output carries counts and file:line, never the note path text", () => {
  const vault = makeVault(["Notes/Some Private Note.md"]);
  const dir = makeRepo({ "docs/leak.md": "Notes/Some Private Note.md\n" });
  const r = run(dir, "--vault", vault);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /Private/);
  assert.doesNotMatch(r.out, /Some/);
  assert.match(r.out, /1 PROBLEM/);
});

test("RED: a non-ASCII, unnumbered folder is caught, whatever the Unicode normalisation", () => {
  const vault = makeVault(["Dossier/Résumé Plan.md"]); // NFC in the vault
  const nfd = "Dossier/Résumé Plan.md"; // NFD in the tracked file
  const dir = makeRepo({ "t/a.test.ts": `const p = "${nfd}";\n` });
  assert.equal(run(dir, "--vault", vault).code, 1);
});

test("RED: a real note in a CJK folder is caught", () => {
  const vault = makeVault(["资源/软件梳理.md"]);
  const dir = makeRepo({ "t/a.ts": 'const p = "资源/软件梳理.md";\n' });
  assert.equal(run(dir, "--vault", vault).code, 1);
});

test("RED: a real ROOT-level note name is caught", () => {
  const vault = makeVault(["Some Root Note.md"]);
  const dir = makeRepo({ "docs/a.md": 'open "Some Root Note.md" now\n' });
  assert.equal(run(dir, "--vault", vault).code, 1);
});

test("the NN-folder shape is still caught", () => {
  const vault = makeVault(["02-projects/Plan.md"]);
  const dir = makeRepo({ "a.ts": 'const p = "02-projects/Plan.md";\n' });
  assert.equal(run(dir, "--vault", vault).code, 1);
});

test("an invented path that is not in the vault passes deep mode", () => {
  const vault = makeVault(["Notes/Some Private Note.md"]);
  const dir = makeRepo({ "a.ts": 'const p = "Notes/Invented Note.md";\n' });
  assert.equal(run(dir, "--vault", vault).code, 0);
});

test("a ROOT-level note name that is only the tail of a different path is not a match", () => {
  const vault = makeVault(["Some Root Note.md"]);
  const dir = makeRepo({ "a.ts": 'const p = "elsewhere/Some Root Note.md";\n' });
  assert.equal(run(dir, "--vault", vault).code, 0);
});

test("a vault note path embedded in a longer absolute path is still caught", () => {
  const vault = makeVault(["Notes/Some Private Note.md"]);
  const dir = makeRepo({ "a.ts": 'const p = "/mnt/data/Notes/Some Private Note.md";\n' });
  assert.equal(run(dir, "--vault", vault).code, 1);
});

test("the product's own memory signal note name is not a leak", () => {
  const vault = makeVault(["memory/_next-session.md", "_next-session.md"]);
  const dir = makeRepo({
    "a.ts": 'const a = "memory/_next-session.md"; const b = "_next-session.md";\n',
  });
  assert.equal(run(dir, "--vault", vault).code, 0);
});

test("a root note named like a file the repo itself tracks is not a leak", () => {
  const vault = makeVault(["CLAUDE.md"]);
  const dir = makeRepo({ "CLAUDE.md": "rules\n", "docs/a.md": "see CLAUDE.md for the rules\n" });
  assert.equal(run(dir, "--vault", vault).code, 0);
});

test("RED: a foldered real note path cited WITHOUT its .md suffix is caught", () => {
  const vault = makeVault(["Notes/Some Private Note.md"]);
  const dir = makeRepo({ "docs/plan.md": "the analysis lives in `Notes/Some Private Note`.\n" });
  const r = run(dir, "--vault", vault);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[REAL-NOTE\] docs\/plan\.md:1/);
});

test("a suffix-less path that is only a folder prefix, a stem or a bare word is not a match", () => {
  const vault = makeVault(["Notes/Some Private Note.md", "Common.md"]);
  const dir = makeRepo({
    "a.ts": [
      'const a = "Notes/Some Private Note/attachments/x.png";',
      'const b = "Notes/Some Private Note.ts";',
      'const c = "Notes/Some Private Note.mdx";',
      'const d = "a common word: Common";',
    ].join("\n"),
  });
  const r = run(dir, "--vault", vault);
  assert.equal(r.code, 0, r.out);
});
