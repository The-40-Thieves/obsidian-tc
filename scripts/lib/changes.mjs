// CHANGELOG fragments: `changes/<slug>.md`, one file per change, assembled into the release
// section by scripts/release.mjs. Two PRs that each add a release note used to both append to the
// same `[Unreleased]` block in CHANGELOG.md and conflict by construction; a fragment is a NEW file
// named for its own change, so two PRs can never touch the same line.
//
// Fragment shape (front matter is required; the body is verbatim CHANGELOG markdown, normally one
// `- **Lead.** ...` bullet):
//
//   ---
//   type: Added
//   ---
//   - **Lead sentence.** What changed and what a user must do about it.
//
// Write the fragment WITHOUT its PR number: a PR cannot know its own number before it is opened,
// and committing it afterwards forces a second full verification run. The release fills it in
// (`fillPrNumbers`) from the git history that merged the fragment, as `(#N)` at the end of the
// first bullet. A fragment that already cites `(#N)` is left exactly as written. The validator
// accepts both forms.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Keep-a-Changelog section names, in the order they render when a section is created. */
export const CHANGE_TYPES = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];
export const FRAGMENT_DIR = "changes";
const UNRELEASED = "## [Unreleased]";

/**
 * Parse one fragment. Throws with the file name on any shape problem so the validator and the
 * release both refuse the same inputs — a fragment the release would silently drop is the failure
 * this exists to prevent.
 */
export function parseFragment(text, file) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file}: missing "---" front matter block with a "type:" line`);
  const fields = new Map();
  for (const line of m[1].split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`${file}: unreadable front matter line "${line}"`);
    fields.set(kv[1], kv[2].trim());
  }
  for (const key of fields.keys()) {
    if (key !== "type" && key !== "config-schema-change") {
      throw new Error(
        `${file}: unknown front matter key "${key}" (allowed: type, config-schema-change)`,
      );
    }
  }
  const type = fields.get("type");
  if (!type || !CHANGE_TYPES.includes(type)) {
    throw new Error(
      `${file}: type must be one of ${CHANGE_TYPES.join(", ")} (got "${type ?? ""}")`,
    );
  }
  const body = m[2].trim();
  if (body === "") throw new Error(`${file}: empty body`);
  if (!/^- /.test(body)) throw new Error(`${file}: body must start with a "- " bullet`);
  const schemaChange = (fields.get("config-schema-change") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { file, type, body, schemaChange };
}

/** Every fragment under `dir`, sorted by file name so assembly is deterministic. README is docs. */
export function readFragments(root = ".", dir = FRAGMENT_DIR) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .sort()
    .map((f) => parseFragment(readFileSync(join(abs, f), "utf8"), `${dir}/${f}`));
}

/** `(#N` anywhere: `(#12)`, `(#12, closes #3)`. A bare `#N` is a reference, not the fragment's own PR. */
const CITES_PR = /\(#\d+/;

/** Append `(#n)` to the end of the first bullet, before its final period when it has one. */
function citePr(body, n) {
  const nextBullet = body.search(/\n- /);
  const first = nextBullet === -1 ? body : body.slice(0, nextBullet);
  const rest = nextBullet === -1 ? "" : body.slice(nextBullet);
  const text = first.trimEnd();
  const cited = text.endsWith(".") ? `${text.slice(0, -1)} (#${n}).` : `${text} (#${n})`;
  return cited + first.slice(text.length) + rest;
}

/**
 * Fragments with `(#N)` filled in where the bullet has none. `prOf(file)` returns the PR number
 * (string) or a falsy value; it is never called for a fragment that already cites one, so a tree
 * of fully cited fragments is returned untouched. Throws naming every fragment whose PR cannot be
 * determined: shipping a release note with no PR would silently fail the release's coverage gate.
 */
export function fillPrNumbers(fragments, prOf) {
  const unresolved = [];
  const out = fragments.map((f) => {
    if (CITES_PR.test(f.body)) return f;
    const n = prOf(f.file);
    if (!n) {
      unresolved.push(f.file);
      return f;
    }
    return { ...f, body: citePr(f.body, n) };
  });
  if (unresolved.length > 0) {
    throw new Error(
      `cannot determine the PR that added ${unresolved.join(", ")}. A fragment reaches a release ` +
        `through a merged PR (a "Merge pull request #N" commit, or a "(#N)" subject on the commit ` +
        `that added it); cite "(#N)" in the fragment by hand if it did not. A shallow clone cuts ` +
        `that history off: run "git fetch --unshallow" first.`,
    );
  }
  return out;
}

/**
 * `file -> PR number` from git history alone: the oldest commit that added the file, then the
 * first `Merge pull request #N` commit whose second-parent side contains it (the merge queue
 * merges with merge commits), else a trailing `(#N)` on that commit's own subject (a squash
 * merge). `null` when the file was never committed or never reached `ref` through a PR.
 */
export function gitPrOf(root = ".", ref = "HEAD") {
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const isAncestor = (a, b) => {
    try {
      git("merge-base", "--is-ancestor", a, b);
      return true;
    } catch {
      return false;
    }
  };
  return (file) => {
    let added;
    try {
      added = git("log", "--diff-filter=A", "--format=%H%x09%P%x09%s", ref, "--", file)
        .split("\n")
        .filter(Boolean);
    } catch {
      return null;
    }
    const oldest = added.at(-1);
    if (!oldest) return null;
    const [sha, parents, ...subject] = oldest.split("\t");
    // No parent: the root commit, or a shallow-clone boundary that "adds" every file it holds.
    if (!parents) return null;
    const squash = /\(#(\d+)\)\s*$/.exec(subject.join("\t"));
    if (squash) return squash[1];
    let merges;
    try {
      merges = git(
        "log",
        "--merges",
        "--ancestry-path",
        "--reverse",
        "--format=%P%x09%s",
        `${sha}..${ref}`,
      )
        .split("\n")
        .filter(Boolean);
    } catch {
      return null;
    }
    for (const line of merges) {
      const [parents, subject] = line.split("\t");
      const pr = /^Merge pull request #(\d+)\b/.exec(subject ?? "");
      if (!pr) continue;
      const [first, second] = parents.split(" ");
      if (second && isAncestor(sha, second) && !isAncestor(sha, first)) return pr[1];
    }
    return null;
  };
}

/** Split an `[Unreleased]` body into its preamble and its `### Heading` sections, in order. */
function splitSections(body) {
  const lines = body.split("\n");
  const sections = [];
  const preamble = [];
  let cur = null;
  for (const line of lines) {
    const h = /^###\s+(.+?)\s*$/.exec(line);
    if (h) {
      cur = { heading: h[1], lines: [] };
      sections.push(cur);
    } else if (cur) cur.lines.push(line);
    else preamble.push(line);
  }
  return { preamble: preamble.join("\n").trim(), sections };
}

/**
 * The `[Unreleased]` body with every fragment appended to its type's section (created in canonical
 * order when absent). Fragments sort by file name within a section, after whatever was already
 * written by hand, so the result is a pure function of the two inputs.
 */
export function assembleUnreleased(legacyBody, fragments) {
  const { preamble, sections } = splitSections(legacyBody);
  const byType = new Map(sections.map((s) => [s.heading, s]));
  for (const type of CHANGE_TYPES) {
    const mine = fragments.filter((f) => f.type === type);
    if (mine.length === 0) continue;
    let sec = byType.get(type);
    if (!sec) {
      sec = { heading: type, lines: [] };
      sections.push(sec);
      byType.set(type, sec);
    }
    const existing = sec.lines.join("\n").trim();
    sec.text = [existing, ...mine.map((f) => f.body)].filter(Boolean).join("\n\n");
  }
  const out = [];
  if (preamble) out.push(preamble);
  for (const s of sections) {
    const text = s.text ?? s.lines.join("\n").trim();
    out.push(`### ${s.heading}${text ? `\n\n${text}` : ""}`);
  }
  return out.join("\n\n");
}

/** Locate the `[Unreleased]` body inside a CHANGELOG. `null` when the heading is missing. */
export function locateUnreleased(changelog) {
  const at = changelog.indexOf(UNRELEASED);
  if (at === -1) return null;
  const start = at + UNRELEASED.length;
  const next = changelog.indexOf("\n## [", start);
  const end = next === -1 ? changelog.length : next;
  return { at, start, end, body: changelog.slice(start, end).trim() };
}

/** The CHANGELOG text as it reads once fragments are folded into `[Unreleased]` (read-only view). */
export function changelogWithFragments(changelog, fragments) {
  const loc = locateUnreleased(changelog);
  if (!loc || fragments.length === 0) return changelog;
  const body = assembleUnreleased(loc.body, fragments);
  return `${changelog.slice(0, loc.start)}\n\n${body}\n${changelog.slice(loc.end)}`;
}

/**
 * Roll `[Unreleased]` into `## [version] - date` (fragments folded in) and prepend a fresh empty
 * `[Unreleased]`. Returns `{ text, body }`; `body` is what the new section holds, which the
 * release's PR-coverage gate searches. Throws when the section is missing or would be empty.
 */
export function rollUnreleased(changelog, fragments, version, date) {
  const loc = locateUnreleased(changelog);
  if (!loc) throw new Error("CHANGELOG.md has no [Unreleased] section.");
  const body = assembleUnreleased(loc.body, fragments);
  if (!body) {
    throw new Error(
      "CHANGELOG [Unreleased] is empty and changes/ has no fragments; add release notes before releasing.",
    );
  }
  const text =
    changelog.slice(0, loc.at) +
    `${UNRELEASED}\n\n## [${version}] - ${date}\n\n${body}\n` +
    (loc.end >= changelog.length ? "\n" : `\n${changelog.slice(loc.end + 1)}`);
  return { text, body };
}
