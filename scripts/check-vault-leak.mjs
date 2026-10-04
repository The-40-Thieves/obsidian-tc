#!/usr/bin/env node
// Fail the build if private vault data is tracked in this repository.
//
// WHY THIS EXISTS: for two weeks this public repo served a map of a personal Obsidian vault — 227 real
// note paths, 136 plain-English descriptions of their contents, and (via a committed SQLite index) the
// FULL TEXT of 100 notes, including health records. Six code reviews missed it, because every one of them
// audited the DIFF and none audited the REPO. A grep would have found it in a second. This is that grep.
//
// TWO LAYERS, because they answer different questions:
//
//   STRUCTURAL (default, runs in CI, needs no vault) — whole artifacts that are never legitimate: a
//   committed index, a golden set, the operator's vault path. Cheap and deterministic on exactly the
//   things that burned us.
//
//   DEEP (--vault <path>, runs locally where the vault exists) — CONTENT leaks: a real note path pasted
//   into a test fixture. CI structurally cannot do this: a real note path and an invented one are
//   indistinguishable to a regex. Only the vault knows. And the machine holding the vault is the machine
//   where such a leak originates, so that is where it runs. It matches EVERY `.md`-terminated string
//   against the vault's real relative paths, whatever their shape (numbered or plain folder, any script).
//   Its output is counts and file:line, never the matched path: a log line must not become the leak.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

const args = process.argv.slice(2);
const vaultIdx = args.indexOf("--vault");
const VAULT = vaultIdx !== -1 ? args[vaultIdx + 1] : null;

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
const failures = [];
const fail = (file, line, rule, detail) => failures.push({ file, line, rule, detail });

const SELF = "scripts/check-vault-leak.mjs";
const isText = (f) => !/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|node|db|wasm|pdf)$/i.test(f);

// ── STRUCTURAL ──────────────────────────────────────────────────────────────────────────────────────
const GOLDEN_DIR = "packages/server/eval/corpora/golden/";
const REGISTRY = "packages/server/eval/corpora/corpora.json";
const DATA_EXT = "ya?ml|jsonc?|json5|jsonl|ndjson";

// A golden set keys queries to note paths, so a PRIVATE one is the exact leak this guard exists for. Two
// narrow ways in, and nothing else:
//   (a) `<name>.example.yaml` — a synthetic set, minted from a seed.
//   (b) `eval/corpora/golden/<id>.json` where `<id>` is registered in corpora.json with a pinned PUBLIC
//       source (a repo and a full commit sha) and a licence: the golden set of a corpus anyone can fetch.
// Verified by reading the registry, not by trusting a file name.
const publicCorpusIds = new Set();
if (tracked.includes(REGISTRY)) {
  try {
    const { corpora } = JSON.parse(readFileSync(REGISTRY, "utf8"));
    for (const [id, c] of Object.entries(corpora ?? {})) {
      const pinned =
        typeof c?.repo === "string" &&
        /^[\w.-]+\/[\w.-]+$/.test(c.repo) &&
        typeof c.commit === "string" &&
        /^[0-9a-f]{40}$/.test(c.commit) &&
        typeof c.licence === "string" &&
        c.licence.trim() !== "";
      if (pinned) publicCorpusIds.add(id);
    }
  } catch {
    fail(REGISTRY, 0, "corpora-registry", "unreadable: no golden set can be registered against it");
  }
}
const registeredGolden = (f) => {
  if (!f.startsWith(GOLDEN_DIR)) return false;
  const m = /^([^/]+)\.json$/.exec(f.slice(GOLDEN_DIR.length));
  return m !== null && publicCorpusIds.has(m[1]);
};
const goldenAllowed = (f) => f.endsWith(".example.yaml") || registeredGolden(f);
const registeredGoldenCount = tracked.filter(registeredGolden).length;

for (const f of tracked) {
  // A committed index is never legitimate. This is the artifact that leaked 100 notes in full.
  if (f.startsWith(".obsidian-tc/")) {
    fail(f, 0, "committed-index", "a vault index must never be tracked");
  }
  if (/\.(db|sqlite3?)(-wal|-shm)?$/.test(f)) {
    fail(f, 0, "database", "database files must never be tracked");
  }
  // A golden set keys queries to real note paths. Only the two allowances above may be committed.
  if (new RegExp(`golden-set.*\\.(${DATA_EXT})$`).test(f) && !goldenAllowed(f)) {
    fail(f, 0, "golden-set", "golden sets contain real note paths; keep them gitignored");
  }
}

// Golden-set keys, YAML or JSON, quoted or not. Quoted anywhere on the line (a minified JSON file is one
// line); unquoted only as a line-leading or flow-style key, so prose that mentions the word is not hit.
const QUOTED_KEY = /["'](?:seed|target|bridge)_paths["']\s*:/;
const BARE_KEY = /(?:^\s*(?:-\s*)?|[{,]\s*)(?:seed|target|bridge)_paths\s*:/;
const DATA_FILE = new RegExp(`\\.(${DATA_EXT})$`);

for (const f of tracked) {
  if (!isText(f) || f === SELF) continue;
  let body;
  try {
    body = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  body.split("\n").forEach((line, i) => {
    // The operator's real vault location. Docs and tests must use a placeholder.
    if (/Obsidian[/\\]Second Brain|["'`][A-Z]:[/\\]Obsidian/.test(line)) {
      fail(f, i + 1, "vault-path", "use a placeholder, not the real vault location");
    }
    // Golden-set structure in a DATA file. Deliberately NOT in source: a `seed_paths` field in a .ts file
    // is a schema declaration — the code that READS a golden set — which is exactly what this repo should
    // contain. The data is the problem, never the schema. A first draft of this rule conflated them and
    // flagged 24 legitimate type declarations, which is how a guard teaches people to ignore it.
    if (DATA_FILE.test(f) && !goldenAllowed(f) && (QUOTED_KEY.test(line) || BARE_KEY.test(line))) {
      fail(f, i + 1, "golden-set-shape", "golden-set data keyed to real notes");
    }
  });
}

// ── DEEP (needs the vault) ──────────────────────────────────────────────────────────────────────────
// A real note path anywhere in tracked content, checked against the relative paths of the notes that
// ACTUALLY exist (exact match, case-insensitive, Unicode-normalised). A match is a real note path sitting
// in a public repo; an invented one is fine. Every shape, not just `NN-folder/`: the first version only
// matched that, so a real path under an unnumbered or non-ASCII folder walked straight past it.
//
// Two forms are matched: the full `folder/Note.md` path, and a FOLDERED path with its `.md` dropped
// (`folder/Note`), which is how prose and plan docs cite a note. A bare root-level name without `.md`
// (`Index`) is a common word, so it is not matched. Measured on the tree this landed on (1,498 notes,
// 2,315 files): the `.md` form raised 63 raw hits, all names the repo itself uses (see the exemptions); the
// suffix-less foldered form raised 12, ten of them the same product note and two real citations that were
// then removed. All 12 are exempt or fixed, so the check is clean and carries no tolerated list.
//
// Matching walks a trie of the note paths from each path boundary, so cost is linear in the tracked text
// (about 2 s on that tree) rather than notes x lines (about 110 s for a naive substring scan).
if (VAULT) {
  const norm = (s) => s.toLowerCase().normalize("NFC");
  const isWord = (c) => /[\p{L}\p{N}_]/u.test(c);
  // Names this product itself defines (the memory signal note), and any note whose name is a file this
  // repo already tracks (CLAUDE.md, AGENTS.md ...): public already, so naming it discloses nothing.
  const trackedPaths = new Set(tracked.map(norm));
  const trackedNames = new Set(tracked.map((f) => norm(basename(f))));
  const PRODUCT_NAMES = new Set(["_next-session.md", "memory/_next-session.md"]);

  const root = { next: new Map(), end: false };
  let noteCount = 0;
  const insert = (text) => {
    let node = root;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let child = node.next.get(ch);
      if (!child) {
        child = { next: new Map(), end: false };
        node.next.set(ch, child);
      }
      node = child;
    }
    node.end = true;
  };
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (e.startsWith(".")) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".md")) {
        const rel = norm(relative(VAULT, p).split(sep).join("/"));
        const foldered = rel.includes("/");
        if (PRODUCT_NAMES.has(rel) || (foldered ? trackedPaths.has(rel) : trackedNames.has(rel))) {
          continue;
        }
        noteCount++;
        insert(rel);
        if (foldered) insert(rel.slice(0, -3));
      }
    }
  };
  walk(VAULT);

  // Does a note path end at `end`? With `.md`, only a following word character (`.mdx`) disqualifies. A
  // suffix-less path must also not be a folder prefix (`a/b/c`) or the stem of another file (`a/b.ts`).
  const endsCleanly = (line, end, suffixed) => {
    const c = line[end];
    if (c === undefined) return true;
    if (isWord(c)) return false;
    if (suffixed) return true;
    return c !== "/" && !(c === "." && end + 1 < line.length && isWord(line[end + 1]));
  };
  const namesANote = (line) => {
    for (let s = 0; s < line.length; s++) {
      // A path starts at a boundary. A bare root-level name must not be the tail of a longer path
      // (`other/Name.md` is not the root note `Name.md`); a foldered path may sit inside an absolute one.
      const prev = s > 0 ? line[s - 1] : "";
      if (prev && isWord(prev)) continue;
      let node = root;
      let sawSlash = false;
      for (let j = s; j < line.length; j++) {
        node = node.next.get(line[j]);
        if (!node) break;
        sawSlash ||= line[j] === "/";
        if (node.end && endsCleanly(line, j + 1, line.endsWith(".md", j + 1))) {
          if (sawSlash || !(prev === "/" || prev === "\\")) return true;
        }
      }
    }
    return false;
  };

  if (noteCount > 0) {
    for (const f of tracked) {
      if (!isText(f) || f === SELF) continue;
      let body;
      try {
        body = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      body.split("\n").forEach((raw, i) => {
        if (namesANote(norm(raw))) {
          fail(f, i + 1, "REAL-NOTE", "names an actual note in the vault (text withheld)");
        }
      });
    }
  }
}

// ── REPORT ──────────────────────────────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  const mode = VAULT ? "structural + deep" : "structural only";
  const sets = `${registeredGoldenCount} registered public golden set${registeredGoldenCount === 1 ? "" : "s"}`;
  console.log(`vault-leak: clean (${tracked.length} tracked files, ${mode}; ${sets})`);
  if (!VAULT) {
    console.log("  deep check skipped — pass --vault <path> to compare against real note titles");
  }
  process.exit(0);
}

console.error(
  `vault-leak: ${failures.length} PROBLEM(S) — private vault data must not be tracked\n`,
);
for (const x of failures) {
  console.error(`  [${x.rule}] ${x.file}${x.line ? `:${x.line}` : ""}`);
  console.error(`      ${x.detail}`);
}
console.error(
  "\nIf a hit is a synthetic fixture, RENAME it — do not add an exception. The whole point is",
);
console.error(
  "that no real note title ever appears in a public repository, not that we curate a list of",
);
console.error("the ones we tolerate.");
process.exit(1);
