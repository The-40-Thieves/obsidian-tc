// Self-test for the write-ergonomics eval harness (eval/write-ergonomics). It needs no LLM client:
// every task's checker must FAIL on the state a doing-nothing (or wrongly-doing) client leaves, and
// PASS on the reference outcome. A checker that passes on an untouched vault would make every
// client look perfect, so that is the case this file exists to pin.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type ClientOut, parseClaudeStream } from "../eval/write-ergonomics/clients";
import { writeConfig } from "../eval/write-ergonomics/config";
import { decide, type ModeCell, trialNotFound } from "../eval/write-ergonomics/facade-analyze";
import { MEMORY_ENTITY, SEED, writeSeeds } from "../eval/write-ergonomics/fixtures";
import { friction, hookFiredOnError } from "../eval/write-ergonomics/friction";
import {
  applyHook,
  DOMAIN_TOOLS,
  effectiveCall,
  hookMatches,
} from "../eval/write-ergonomics/tap-proxy";
import {
  ALL_TASKS,
  type CheckCtx,
  DISCOVERY_TASKS,
  FACADE_TASK_IDS,
  HARDENED_ACL,
  parseNote,
  TASKS,
  type Task,
} from "../eval/write-ergonomics/tasks";
import { TOOL_DOMAINS } from "../src/mcp/registry/types";
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
    ).toEqual({ tool: "read_note", args: { path: "a.md" }, via: "call_capability" });
    expect(effectiveCall({ name: "read_note", arguments: { path: "b.md" } })).toEqual({
      tool: "read_note",
      args: { path: "b.md" },
      via: "read_note",
    });
  });

  it("unwraps a domain meta-tool call to the capability named in `action` (toolFacade domain mode)", () => {
    expect(
      effectiveCall({
        name: "links",
        arguments: { action: "get_backlinks", args: { path: "a.md" } },
      }),
    ).toEqual({ tool: "get_backlinks", args: { path: "a.md" }, via: "links" });
    // a domain call without args still unwraps; a flat tool that merely has an `action` arg does not
    expect(effectiveCall({ name: "admin", arguments: { action: "get_server_config" } })).toEqual({
      tool: "get_server_config",
      args: {},
      via: "admin",
    });
    expect(effectiveCall({ name: "execute_command", arguments: { action: "x" } }).tool).toBe(
      "execute_command",
    );
  });

  it("DOMAIN_TOOLS is exactly the registry's domain ids plus the `other` sink", () => {
    expect([...DOMAIN_TOOLS].sort()).toEqual([...TOOL_DOMAINS, "other"].sort());
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

  it("flags a hook that fired right after an errored call", () => {
    const hook = { t: 1, dir: "hook" };
    expect(hookFiredOnError([{ t: 0, dir: "s2c", tool: "read_note", isError: true }, hook])).toBe(
      true,
    );
    expect(hookFiredOnError([{ t: 0, dir: "s2c", tool: "read_note", isError: false }, hook])).toBe(
      false,
    );
    expect(hookFiredOnError([{ t: 0, dir: "s2c", tool: "read_note" }])).toBe(false);
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

describe("facade-mode study set", () => {
  it("is 16 tasks, all main-arm, no HITL, every id resolvable, ids unique", () => {
    expect(FACADE_TASK_IDS).toHaveLength(16);
    expect(new Set(ALL_TASKS.map((t) => t.id)).size).toBe(ALL_TASKS.length);
    for (const id of FACADE_TASK_IDS) {
      const t = ALL_TASKS.find((x) => x.id === id);
      expect(t, id).toBeDefined();
      expect(t?.arm, id).toBe("main");
      expect(t?.hitl, id).toBeUndefined();
    }
    expect(DISCOVERY_TASKS).toHaveLength(10);
  });

  it.each(DISCOVERY_TASKS.map((t) => [t.id, t] as [string, Task]))(
    "%s: fails on an empty answer, passes on the reference answer",
    (_id, task) => {
      const v = freshVault();
      expect(task.check(ctx(v)).pass).toBe(false);
      const r = task.check(ctx(v, task.solveCtx));
      expect(r.pass, r.detail).toBe(true);
    },
  );

  it("a discovery checker rejects a plausible wrong answer", () => {
    const v = freshVault();
    const byId = (id: string) => DISCOVERY_TASKS.find((t) => t.id === id) as Task;
    const passes = (id: string, finalText: string) => byId(id).check(ctx(v, { finalText })).pass;
    expect(passes("dx-memory-recall", "Lisbon; she leads the product team")).toBe(false);
    expect(passes("dx-by-property", "Launch Todo")).toBe(false);
    expect(passes("dx-open-tasks", "press announcement")).toBe(false);
    // a long-form date is the right answer too (Codex wrote "November 12, 2026")
    expect(passes("dx-search-fact", "Venue Notes: Harbour Hall, November 12, 2026")).toBe(true);
    expect(passes("dx-search-fact", "Venue Notes: Harbour Hall, November 13, 2026")).toBe(false);
  });

  it("writes toolFacade.mode only when asked, so earlier runs keep the shipped default", () => {
    const d = makeTempDir("obtc-we-cfg-");
    dirs.push(d);
    const p = join(d, "c.json");
    writeConfig(p, "main", "/v", "/c");
    expect(JSON.parse(readFileSync(p, "utf8")).toolFacade).toBeUndefined();
    writeConfig(p, "main", "/v", "/c", "domain");
    expect(JSON.parse(readFileSync(p, "utf8")).toolFacade).toEqual({ mode: "domain" });
  });

  it("counts a server-side unknown-tool answer as a not-found, not a missing note", () => {
    const e = (text: string, code: string) => ({
      t: 0,
      dir: "s2c",
      tool: "x",
      args: {},
      isError: true,
      code,
      text,
    });
    const f = friction([
      e('[{"text":"unknown tool: get_backlink"}]', "not_found"),
      e('[{"text":"note not found: a.md"}]', "not_found"),
    ]);
    expect(f.errors).toBe(2);
    expect(f.toolNotFound).toBe(1);
  });

  it("reads Claude's stream-json: result event, ToolSearch calls and client-side not-found errors", () => {
    const out: ClientOut = {
      finalText: "",
      usage: { billable: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      turns: 0,
      exit: 0,
      timedOut: false,
      otherTools: [],
      toolSearchCalls: 0,
      clientNotFound: 0,
      clientNotFoundExcerpts: [],
      raw: "",
    };
    const lines = [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "a", name: "ToolSearch" }] },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "b",
              is_error: true,
              content: "Error: No such tool available: mcp__obsidian-tc__get_backlinks",
            },
          ],
        },
      },
      { type: "result", result: "done", num_turns: 3 },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    expect(parseClaudeStream(lines, out)).toMatchObject({ result: "done", num_turns: 3 });
    expect(out.toolSearchCalls).toBe(1);
    expect(out.clientNotFound).toBe(1);
    expect(() => parseClaudeStream('{"type":"assistant"}', out)).toThrow(/no result event/);
  });
});

describe("facade-mode decision rule", () => {
  const cell = (mode: ModeCell["mode"], over: Partial<ModeCell>): ModeCell => ({
    client: "claude",
    mode,
    trials: 32,
    passes: 28,
    medianCallsToSuccess: 3,
    notFoundTrials: 0,
    notFoundEvents: 0,
    medianBillable: 6000,
    meanCacheWrite: 5000,
    meanToolSearch: 1,
    meanDiscovery: 0.5,
    errors: 0,
    timeouts: 0,
    ...over,
  });
  const verdict = (cells: ModeCell[]) => decide(cells)[0];

  it("keeps the shipped default when nothing beats it by the pre-registered margin", () => {
    const v = verdict([
      cell("triad", {}),
      cell("domain", { passes: 29, medianCallsToSuccess: 2 }),
      cell("flat", { passes: 28 }),
    ]);
    expect(v?.recommended).toBe("triad");
  });

  it("switches when a mode beats triad on success by more than the tie band", () => {
    const v = verdict([
      cell("triad", { passes: 22 }),
      cell("domain", { passes: 29 }),
      cell("flat", { passes: 24 }),
    ]);
    expect(v?.recommended).toBe("domain");
    expect(v?.tied).toEqual(["domain"]);
  });

  it("switches on a success tie only when calls AND not-found are both better", () => {
    const base = [
      cell("triad", { notFoundTrials: 2 }),
      cell("flat", { medianCallsToSuccess: 2, notFoundTrials: 2 }),
      cell("domain", { passes: 10 }),
    ];
    expect(verdict(base)?.recommended).toBe("triad");
    const both = [
      cell("triad", { notFoundTrials: 2 }),
      cell("flat", { medianCallsToSuccess: 2, notFoundTrials: 0 }),
      cell("domain", { passes: 10 }),
    ];
    expect(verdict(both)?.recommended).toBe("flat");
  });

  it("does not decide a client that is missing a mode or holds a partial cell", () => {
    expect(decide([cell("triad", {}), cell("domain", {})])).toEqual([]);
    expect(
      decide([cell("triad", {}), cell("domain", {}), cell("flat", { trials: 3, passes: 3 })]),
    ).toEqual([]);
  });

  it("flags a close cell: tied on success, calls within 0.5, same not-found", () => {
    const v = verdict([
      cell("triad", {}),
      cell("domain", { medianCallsToSuccess: 3.5 }),
      cell("flat", { passes: 10 }),
    ]);
    expect(v?.close).toBe(true);
  });
});

describe("facade-mode not-found metric", () => {
  it("does not count a miss on a built-in tool (Bash is disabled) as a discovery failure", () => {
    const trial = (excerpts: string[], server = 0) =>
      ({
        friction: { toolNotFound: server },
        clientNotFoundExcerpts: excerpts,
      }) as unknown as Parameters<typeof trialNotFound>[0];
    const bash =
      "<tool_use_error>Error: No such tool available: Bash. Bash is disabled</tool_use_error>";
    const mcp = "Error: No such tool available: mcp__obsidian-tc__get_backlinks";
    expect(trialNotFound(trial([bash]))).toBe(0);
    expect(trialNotFound(trial([bash, mcp], 1))).toBe(2);
  });
});
