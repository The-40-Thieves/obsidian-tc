import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseFragment } from "./lib/changes.mjs";
import { unacknowledgedDescriptionChanges as unacked } from "./lib/tool-descriptions.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-tool-description-acks.mjs");

const base = {
  "flat/read_note": "Read a note.",
  "flat/write_note": "Write a note.",
  "triad/find_capability": "Find.",
  "domain/notes":
    "Notes. Call with action.\nActions:\n- read_note: Read a note.\n- write_note: Write a note.",
};

test("an unchanged snapshot needs no acknowledgement", () => {
  assert.deepEqual(unacked(base, { ...base }, []), []);
});

test("a changed description is refused until its tool is named", () => {
  const head = { ...base, "flat/read_note": "Read a note, now with frontmatter." };
  assert.deepEqual(
    unacked(base, head, []).map((b) => b.key),
    ["flat/read_note"],
  );
  assert.deepEqual(unacked(base, head, ["read_note"]), []);
  assert.deepEqual(unacked(base, head, ["flat/read_note"]), []);
  // Naming a different tool acknowledges nothing.
  assert.equal(unacked(base, head, ["write_note"]).length, 1);
});

test("a tool name acknowledges every surface carrying it", () => {
  const head = {
    ...base,
    "triad/find_capability": "Find, differently.",
    "flat/find_capability": "x",
  };
  const b = { ...base, "flat/find_capability": "y" };
  assert.deepEqual(unacked(b, head, ["find_capability"]), []);
  assert.equal(unacked(b, head, ["triad/find_capability"]).length, 1);
});

test("added and removed tools are not description changes", () => {
  const head = { ...base, "flat/new_tool": "New." };
  delete head["flat/write_note"];
  const out = unacked(
    { ...base },
    {
      ...head,
      "domain/notes":
        "Notes. Call with action.\nActions:\n- read_note: Read a note.\n- new_tool: New.",
    },
    [],
  );
  // The domain text moved only by a member line for an added tool and a removed one.
  assert.deepEqual(out, []);
});

test("a domain entry whose member line moved is covered by the member's acknowledgement", () => {
  const head = {
    ...base,
    "flat/read_note": "Read a note, v2.",
    "domain/notes":
      "Notes. Call with action.\nActions:\n- read_note: Read a note, v2.\n- write_note: Write a note.",
  };
  assert.deepEqual(
    unacked(base, head, ["read_note"]).map((b) => b.key),
    [],
  );
  assert.deepEqual(
    unacked(base, head, []).map((b) => b.key),
    ["domain/notes", "flat/read_note"],
  );
});

test("a domain header change needs the domain's own name", () => {
  const head = {
    ...base,
    "domain/notes":
      "Notes, reworded. Call with action.\nActions:\n- read_note: Read a note.\n- write_note: Write a note.",
  };
  assert.equal(unacked(base, head, ["read_note", "write_note"]).length, 1);
  assert.deepEqual(unacked(base, head, ["notes"]), []);
  assert.deepEqual(unacked(base, head, ["domain/notes"]), []);
});

test("tool-description-change front matter is parsed into a name list", () => {
  const f = parseFragment(
    "---\ntype: Changed\ntool-description-change: read_note, search\n---\n- **C.** x\n",
    "changes/c.md",
  );
  assert.deepEqual(f.toolDescriptionChange, ["read_note", "search"]);
  assert.deepEqual(f.schemaChange, []);
  assert.deepEqual(
    parseFragment("---\ntype: Added\n---\n- x\n", "changes/d.md").toolDescriptionChange,
    [],
  );
});

// ---- the script end to end, against a throwaway repository -----------------------------------

const SNAP = "packages/server/test/tool-descriptions.snapshot.json";

function entries(n) {
  const e = {};
  for (let i = 0; i < n; i++) e[`flat/tool_${String(i).padStart(3, "0")}`] = `Description ${i}.`;
  return e;
}

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), "tda-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@example.invalid");
  run("config", "user.name", "t");
  run("config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "packages/server/test"), { recursive: true });
  mkdirSync(join(dir, "changes"));
  const write = (snapshot) =>
    writeFileSync(join(dir, SNAP), `${JSON.stringify(snapshot, null, 2)}\n`);
  return { dir, run, write };
}

const gate = (dir, ...extra) =>
  spawnSync("node", [SCRIPT, "--root", dir, "--base", "main", ...extra], { encoding: "utf8" });

test("script: a changed description fails without a fragment and passes with one", (t) => {
  const { dir, run, write } = repo(t);
  write(entries(160));
  run("add", "-A");
  run("commit", "-q", "-m", "base");
  run("checkout", "-q", "-b", "pr");
  write({ ...entries(160), "flat/tool_007": "Description 7, reworded." });

  const red = gate(dir);
  assert.equal(red.status, 1, red.stdout + red.stderr);
  assert.match(red.stderr, /flat\/tool_007: description changed/);
  assert.match(red.stderr, /tool-description-change:/);

  writeFileSync(
    join(dir, "changes", "x.md"),
    "---\ntype: Changed\ntool-description-change: tool_007\n---\n- **Reworded.** x\n",
  );
  const green = gate(dir);
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.match(green.stdout, /1 changed vs main, all acknowledged/);
});

test("script: an unchanged snapshot passes, and a new tool needs no acknowledgement", (t) => {
  const { dir, run, write } = repo(t);
  write(entries(160));
  run("add", "-A");
  run("commit", "-q", "-m", "base");
  run("checkout", "-q", "-b", "pr");
  write({ ...entries(160), "flat/zz_new": "Brand new." });
  const r = gate(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("script: fails closed on an unresolvable base ref, and passes when the base has no snapshot", (t) => {
  const { dir, run, write } = repo(t);
  write(entries(160));
  const missing = spawnSync("node", [SCRIPT, "--root", dir, "--base", "nope"], {
    encoding: "utf8",
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot resolve base ref "nope"/);

  writeFileSync(join(dir, "README"), "x");
  run("add", "README");
  run("commit", "-q", "-m", "base without a snapshot");
  const intro = gate(dir);
  assert.equal(intro.status, 0, intro.stdout + intro.stderr);
  assert.match(intro.stdout, /introduces it/);
});

test("script: refuses a snapshot below the existence floor", (t) => {
  const { dir, run, write } = repo(t);
  write(entries(10));
  run("add", "-A");
  run("commit", "-q", "-m", "base");
  const r = gate(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /floor 150/);
});
