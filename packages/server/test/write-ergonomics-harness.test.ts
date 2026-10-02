// Self-test for the write-ergonomics eval harness (eval/write-ergonomics). It needs no LLM client:
// every task's checker must FAIL on the state a doing-nothing (or wrongly-doing) client leaves, and
// PASS on the reference outcome. A checker that passes on an untouched vault would make every
// client look perfect, so that is the case this file exists to pin.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MEMORY_ENTITY, SEED, writeSeeds } from "../eval/write-ergonomics/fixtures";
import { friction } from "../eval/write-ergonomics/friction";
import { applyHook, effectiveCall, hookMatches } from "../eval/write-ergonomics/tap-proxy";
import {
  type CheckCtx,
  HARDENED_ACL,
  parseNote,
  TASKS,
  type Task,
} from "../eval/write-ergonomics/tasks";
import { makeTempDir, rmTemp } from "./tmp";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      /* best effort */
    }
  }
});

const MEMORY_FILE = `---\nobsidian_tc_id: ent_x\nentity_type: person\nstatus: active\n---\n# ${MEMORY_ENTITY.name}\n\n## Observations\n\n${MEMORY_ENTITY.observations.map((o) => `- ${o}`).join("\n")}\n\n## Related\n\n_No relations._\n`;
const TIMEFUL = "notes/2021-03-23 Note to Michael on flat forgetting curves.md";
const TIMEFUL_TEXT =
  '---\nurl: "https://notes.andymatuschak.org/z2dqU3Uu8GeGS9d5axA9nQG"\nmodified: 1970-01-01\n---\n\n# 2021-03-23 Note to Michael on flat forgetting curves\n\nbody\n';

function freshVault(): string {
  const v = makeTempDir("obtc-we-");
  dirs.push(v);
  writeSeeds(v);
  for (const [rel, text] of [
    [MEMORY_ENTITY.path, MEMORY_FILE],
    [TIMEFUL, TIMEFUL_TEXT],
  ] as const) {
    mkdirSync(dirname(join(v, rel)), { recursive: true });
    writeFileSync(join(v, rel), text);
  }
  return v;
}

const ctx = (vault: string, over: Partial<CheckCtx> = {}): CheckCtx => ({
  vault,
  finalText: "",
  calls: [],
  ...over,
});

/** The state a client leaves when it does the WRONG thing, for tasks where "nothing" is the right state. */
const NEGATIVE: Record<string, (v: string) => void> = {
  "undo-bad-edit": (v) =>
    writeFileSync(
      join(v, "Projects/Alpha/Budget.md"),
      "---\ntitle: Alpha Budget\ntags: [project, alpha]\n---\nTODO\n",
    ),
  "create-existing": (v) =>
    writeFileSync(join(v, "Projects/Alpha/Plan.md"), "Alpha plan v2 draft\n"),
  "delete-unapproved": (v) => writeFileSync(join(v, "Inbox/Obsolete.md"), ""),
  "acl-write-locked": (v) =>
    writeFileSync(join(v, "Locked/Policy.md"), `${SEED["Locked/Policy.md"]}Reviewed by legal.\n`),
};

describe("write-ergonomics harness", () => {
  it("has a non-trivial task list with unique ids and both arms", () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(25);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    expect(TASKS.filter((t) => t.arm === "hardened").length).toBeGreaterThanOrEqual(4);
    for (const t of TASKS) expect(t.refCalls, t.id).toBeGreaterThan(0);
  });

  it.each(TASKS.map((t) => [t.id, t] as [string, Task]))(
    "%s: checker fails on the wrong state",
    (id, task) => {
      const v = freshVault();
      NEGATIVE[id]?.(v);
      expect(task.check(ctx(v)).pass, task.check(ctx(v)).detail).toBe(false);
    },
  );

  it.each(TASKS.map((t) => [t.id, t] as [string, Task]))(
    "%s: checker passes on the reference outcome",
    (_id, task) => {
      const v = freshVault();
      task.solve(v);
      const r = task.check(ctx(v, task.solveCtx));
      expect(r.pass, r.detail).toBe(true);
    },
  );

  it("the broken-YAML seed really is unparseable and the concurrent-edit hook names a seeded file", () => {
    expect(parseNote(SEED["Inbox/Messy frontmatter.md"] ?? "").ok).toBe(false);
    for (const t of TASKS.filter((x) => x.hook))
      expect(SEED[t.hook?.file ?? ""], t.id).toBeDefined();
  });

  it("the hardened ACL leaves exactly the two refusal targets unreachable", () => {
    expect(HARDENED_ACL.writePaths.some((g) => g.startsWith("Locked"))).toBe(false);
    expect(HARDENED_ACL.readPaths.some((g) => g.startsWith("Private"))).toBe(false);
    expect(HARDENED_ACL.readPaths.some((g) => g.startsWith("Locked"))).toBe(true);
  });
});

describe("tap proxy helpers", () => {
  it("unwraps call_capability and passes flat calls through", () => {
    expect(
      effectiveCall({
        name: "call_capability",
        arguments: { name: "read_note", args: { path: "a.md" } },
      }),
    ).toEqual({ tool: "read_note", args: { path: "a.md" } });
    expect(effectiveCall({ name: "read_note", arguments: { path: "b.md" } })).toEqual({
      tool: "read_note",
      args: { path: "b.md" },
    });
  });

  it("matches the pre-registered hooks by regex on the tool name and by exact path (regression: === never fired)", () => {
    for (const task of TASKS.filter((x) => x.hook)) {
      const h = task.hook;
      if (!h) continue;
      expect(hookMatches(h, "read_note", { path: h.path }), task.id).toBe(true);
      expect(hookMatches(h, "get_note_headings", { path: h.path }), task.id).toBe(true);
      expect(hookMatches(h, "patch_note", { path: h.path }), task.id).toBe(false);
      expect(hookMatches(h, "read_note", { path: "other.md" }), task.id).toBe(false);
      // regression: a first read that failed validation (no `vault`) fired the hook before the model's
      // first successful read, so the hash it sent was fresh and the CAS path was never exercised.
      expect(hookMatches(h, "read_note", { path: h.path }, true), task.id).toBe(false);
    }
  });

  it("applies an append hook and a replace hook, and refuses a replace whose text is absent", () => {
    const v = makeTempDir("obtc-we-hook-");
    dirs.push(v);
    writeFileSync(join(v, "n.md"), "alpha\n");
    applyHook(v, { afterTool: "x", file: "n.md", appendText: "beta\n" });
    expect(readFileSync(join(v, "n.md"), "utf8")).toBe("alpha\nbeta\n");
    applyHook(v, { afterTool: "x", file: "n.md", replace: { find: "alpha", with: "$&-gamma" } });
    expect(readFileSync(join(v, "n.md"), "utf8")).toBe("$&-gamma\nbeta\n");
    expect(() =>
      applyHook(v, { afterTool: "x", file: "n.md", replace: { find: "zzz", with: "q" } }),
    ).toThrow(/absent/);
  });
});

describe("friction metrics", () => {
  it("separates discovery from real calls and counts retries, recovery hints and recoveries", () => {
    const e = (tool: string, isError = false, code?: string, recovery?: string) => ({
      t: 0,
      dir: "s2c",
      tool,
      args: {},
      isError,
      code,
      recovery,
      bytes: 10,
    });
    const f = friction([
      { t: 0, dir: "c2s", clientInfo: { name: "claude-code" } },
      e("find_capability"),
      e("write_note", true, "validation_error", "fix the args"),
      e("write_note", true, "elicit_required"),
      e("write_note"),
      { t: 0, dir: "hook" },
    ]);
    expect(f).toMatchObject({
      clientName: "claude-code",
      toolsCalls: 4,
      discoveryCalls: 1,
      realCalls: 3,
      errors: 2,
      errorsWithRecovery: 1,
      errorsRecovered: 2,
      retries: 2,
      elicitRequired: 1,
      hookFired: true,
    });
  });
});
