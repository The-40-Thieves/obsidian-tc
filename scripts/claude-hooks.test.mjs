// Tests for the generated-artifact guard in .claude/: block-generated-edits.sh (PreToolUse,
// Edit|Write), generated-drift-backstop.sh (PostToolUse, Bash) and the single source of truth they
// share, .claude/generated-paths.txt.
//
// Each case runs the real hook script against a throwaway git repo that carries its OWN copy of
// generated-paths.txt, so "a path added only to the txt" and "a path only in the script" are
// testable without touching the real list. The hooks resolve the txt from the repo that owns the
// edited file / cwd, which is also what makes them correct inside the per-agent worktrees.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BLOCK = join(REPO, ".claude/hooks/block-generated-edits.sh");
const BACKSTOP = join(REPO, ".claude/hooks/generated-drift-backstop.sh");
const REAL_TXT = readFileSync(join(REPO, ".claude/generated-paths.txt"), "utf8");
const SCHEMA = "docs/obsidian-tc.config.schema.json";
const EMBEDDED = "packages/server/src/db/migrations-embedded.ts";

const scratch = [];
after(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A committed repo holding both protected files, with `txt` as its generated-paths.txt. */
function makeRepo(txt = REAL_TXT) {
  const dir = mkdtempSync(join(tmpdir(), "claude-hooks-"));
  scratch.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude/generated-paths.txt"), txt);
  mkdirSync(join(dir, "docs"));
  mkdirSync(join(dir, "packages/server/src/db"), { recursive: true });
  writeFileSync(join(dir, SCHEMA), '{"a":1}\n');
  writeFileSync(join(dir, EMBEDDED), "export const X = 1;\n");
  writeFileSync(join(dir, "docs/other.json"), "{}\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function run(script, payload) {
  const r = spawnSync("bash", [script], { input: JSON.stringify(payload), encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const edit = (dir, rel) =>
  run(BLOCK, { tool_name: "Edit", tool_input: { file_path: join(dir, rel) } });

let session = 0;
/** One Bash call as the backstop sees it. `session` pins the per-session marker. */
const bash = (dir, command, sid = "s1") =>
  run(BACKSTOP, {
    session_id: sid,
    cwd: dir,
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { stdout: "", stderr: "" },
  });

const context = (r) => JSON.parse(r.out).hookSpecificOutput.additionalContext;
const freshSid = () => `s${++session}`;

test("generated-paths.txt: tab-separated, both protected paths present with their generator", () => {
  const entries = REAL_TXT.split("\n")
    .filter((l) => l.trim() !== "" && !l.startsWith("#"))
    .map((l) => l.split("\t"));
  assert.ok(entries.length >= 2, "existence floor: the list must not be empty");
  for (const e of entries) assert.equal(e.length, 2, `not <path>\\t<command>: ${e.join(" | ")}`);
  const byPath = new Map(entries);
  assert.equal(byPath.get(SCHEMA), "bun run config:schema");
  assert.equal(byPath.get(EMBEDDED), "bun run migrations:embed");
});

test("settings.json: deny rules mirror the txt, backstop registered on Bash with timeout 5", () => {
  const s = JSON.parse(readFileSync(join(REPO, ".claude/settings.json"), "utf8"));
  const paths = REAL_TXT.split("\n")
    .filter((l) => l.trim() !== "" && !l.startsWith("#"))
    .map((l) => l.split("\t")[0]);
  // A single leading slash is project-root-relative (a `//` prefix would be a filesystem path).
  assert.deepEqual([...s.permissions.deny].sort(), paths.map((p) => `Edit(/${p})`).sort());
  const post = s.hooks.PostToolUse.find((h) => h.matcher === "Bash");
  assert.ok(post, "PostToolUse matcher Bash is registered");
  const hook = post.hooks.find((h) => h.command.endsWith("generated-drift-backstop.sh"));
  assert.ok(hook, "backstop command is registered");
  assert.equal(hook.timeout, 5);
});

for (const rel of [SCHEMA, EMBEDDED]) {
  test(`block: Edit to ${rel} is refused with its regenerate command`, () => {
    const dir = makeRepo();
    const r = edit(dir, rel);
    assert.equal(r.code, 2);
    assert.match(r.err, new RegExp(`BLOCKED: ${rel.replace(/\./g, "\\.")}`));
    assert.match(r.err, rel === SCHEMA ? /bun run config:schema\b/ : /bun run migrations:embed\b/);
  });
}

test("block: an unrelated file and a substring-lookalike path are allowed", () => {
  const dir = makeRepo();
  assert.equal(edit(dir, "docs/other.json").code, 0);
  assert.equal(edit(dir, `${SCHEMA}.bak`).code, 0);
  assert.equal(edit(dir, `docs/notes/${SCHEMA.slice(5)}`).code, 0);
});

test("block: a path added ONLY to the txt is blocked with a generic message naming its command", () => {
  const dir = makeRepo(`${REAL_TXT}docs/other.json\tbun run gen:other\n`);
  const r = edit(dir, "docs/other.json");
  assert.equal(r.code, 2);
  assert.match(r.err, /docs\/other\.json is generated/);
  assert.match(r.err, /bun run gen:other/);
});

test("block: a path that only the script knows is NOT blocked (the txt is the source of truth)", () => {
  const dir = makeRepo(`# nothing protected\ndocs/other.json\tbun run gen:other\n`);
  assert.equal(edit(dir, SCHEMA).code, 0);
  assert.equal(edit(dir, EMBEDDED).code, 0);
});

test("block: comments and blank lines in the txt are ignored; no txt fails open", () => {
  const dir = makeRepo(`# docs/other.json\tbun run nope\n\n   \n`);
  assert.equal(edit(dir, "docs/other.json").code, 0);
  rmSync(join(dir, ".claude/generated-paths.txt"));
  assert.equal(edit(dir, SCHEMA).code, 0);
});

test("backstop: fires for a python heredoc write to the schema, naming the revert and the generator", () => {
  const dir = makeRepo();
  const sid = freshSid();
  writeFileSync(join(dir, SCHEMA), '{"a":2}\n');
  const cmd = `python3 - <<'EOF'\nimport json\njson.dump({'a':2}, open('${SCHEMA}','w'))\nEOF`;
  const r = bash(dir, cmd, sid);
  assert.equal(r.code, 0);
  const ctx = context(r);
  assert.match(ctx, new RegExp(`${SCHEMA.replace(/\./g, "\\.")} changed outside its generator`));
  assert.match(ctx, /git checkout -- docs\/obsidian-tc\.config\.schema\.json/);
  assert.match(ctx, /bun run config:schema/);
  assert.equal(JSON.parse(r.out).hookSpecificOutput.hookEventName, "PostToolUse");
});

test("backstop: silent after the file's own generator ran", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, SCHEMA), '{"a":3}\n');
  const r = bash(dir, "cd /x && bun run config:schema", freshSid());
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
});

test("backstop: a generator for a DIFFERENT file does not excuse the change", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, SCHEMA), '{"a":4}\n');
  const r = bash(dir, "bun run migrations:embed", freshSid());
  assert.match(context(r), /config\.schema\.json changed outside its generator/);
});

test("backstop: silent when nothing protected changed", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "docs/other.json"), '{"x":1}\n');
  const r = bash(dir, "echo hi", freshSid());
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
});

test("backstop: does not nag on later commands once the same state was reported, fires again on a new change", () => {
  const dir = makeRepo();
  const sid = freshSid();
  writeFileSync(join(dir, SCHEMA), '{"a":5}\n');
  assert.notEqual(bash(dir, "sed -i s/1/5/ docs/x", sid).out, "");
  assert.equal(bash(dir, "ls", sid).out, "");
  assert.equal(bash(dir, "git status", sid).out, "");
  writeFileSync(join(dir, SCHEMA), '{"a":6}\n');
  assert.match(context(bash(dir, "ls", sid)), /changed outside its generator/);
});

test("backstop: a regeneration that legitimately left a diff does not nag afterwards", () => {
  const dir = makeRepo();
  const sid = freshSid();
  writeFileSync(join(dir, SCHEMA), '{"a":7}\n');
  assert.equal(bash(dir, "bun run config:schema", sid).out, "");
  assert.equal(bash(dir, "ls", sid).out, "");
});

test("backstop: reverting the file clears the state, so a later hand edit is reported again", () => {
  const dir = makeRepo();
  const sid = freshSid();
  writeFileSync(join(dir, SCHEMA), '{"a":8}\n');
  assert.notEqual(bash(dir, "cmd", sid).out, "");
  git(dir, "checkout", "--", SCHEMA);
  assert.equal(bash(dir, "git checkout -- x", sid).out, "");
  writeFileSync(join(dir, SCHEMA), '{"a":8}\n');
  assert.notEqual(bash(dir, "cmd", sid).out, "");
});

test("backstop: a staged hand edit is still caught (diff is against HEAD)", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, EMBEDDED), "export const X = 2;\n");
  git(dir, "add", EMBEDDED);
  const ctx = context(bash(dir, "git add -A", freshSid()));
  assert.match(ctx, /migrations-embedded\.ts changed outside its generator/);
  assert.match(ctx, /bun run migrations:embed/);
});

test("backstop: merge-driver / install paths (git merge, rebase, bun install) are not blamed", () => {
  for (const cmd of [
    "git merge origin/main",
    "git rebase origin/main",
    "git pull",
    "bun install",
  ]) {
    const dir = makeRepo();
    writeFileSync(join(dir, EMBEDDED), "export const X = 3;\n");
    const r = bash(dir, cmd, freshSid());
    assert.equal(r.out, "", cmd);
  }
});

test("backstop: works from a subdirectory cwd and fails open on bad input / non-repo cwd", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, SCHEMA), '{"a":9}\n');
  assert.match(context(bash(join(dir, "docs"), "x", freshSid())), /changed outside its generator/);
  assert.equal(run(BACKSTOP, { cwd: tmpdir(), tool_input: { command: "x" } }).code, 0);
  const bad = spawnSync("bash", [BACKSTOP], { input: "not json", encoding: "utf8" });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, "");
});
