// THE-602 branch-coverage top-up for tasks-tools.ts. Each test below targets a
// specific uncovered branch leg (matchDue on/before/after, toOutput's optional
// scheduled/start/recur fields, list_tasks' root+paths scoping and priority
// filter, update_task's CRLF/out-of-range/omitted-set legs, and tasks_filter's
// optional sort_by/limit/cursor + a bridge response missing `items`). Every
// assertion checks real output, not just that a branch executed.
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { type M4Vault, makeM4Vault } from "./m4-helpers";

const NOTE = "Notes/todo.md";

function data(res: ToolResult): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected ok result, got ${res.error.code}`);
  return res.data as Record<string, unknown>;
}

describe("list_tasks — matchDue on/before/after legs", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  const CONTENT = [
    "- [ ] task A 📅 2026-06-15",
    "- [ ] task B 📅 2026-06-20",
    "- [ ] task C 📅 2026-06-25",
  ].join("\n");

  it("`on` matches exactly one due date and excludes the rest", async () => {
    v = makeM4Vault({ files: { [NOTE]: CONTENT } });
    const res = await v.call("list_tasks", { vault: "test", due: { on: "2026-06-20" } });
    const items = data(res).items as Record<string, unknown>[];
    expect(items.map((t) => t.description)).toEqual(["task B"]);
  });

  it("`before` includes an earlier due date and excludes one on/after it", async () => {
    v = makeM4Vault({ files: { [NOTE]: CONTENT } });
    const res = await v.call("list_tasks", { vault: "test", due: { before: "2026-06-16" } });
    const items = data(res).items as Record<string, unknown>[];
    expect(items.map((t) => t.description)).toEqual(["task A"]);
  });

  it("`after` includes later due dates and excludes one on/before it", async () => {
    v = makeM4Vault({ files: { [NOTE]: CONTENT } });
    const res = await v.call("list_tasks", { vault: "test", due: { after: "2026-06-16" } });
    const items = data(res).items as Record<string, unknown>[];
    expect(items.map((t) => t.description)).toEqual(["task B", "task C"]);
  });
});

describe("list_tasks — toOutput optional scheduled/start/recur", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("reports scheduled/start/recur when present on the line", async () => {
    v = makeM4Vault({
      files: { [NOTE]: "- [ ] plan trip 🛫 2026-01-01 ⏳ 2026-01-05 🔁 every week" },
    });
    const res = await v.call("list_tasks", { vault: "test" });
    const items = data(res).items as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]?.start).toBe("2026-01-01");
    expect(items[0]?.scheduled).toBe("2026-01-05");
    expect(items[0]?.recur).toBe("every week");
  });
});

describe("list_tasks — priority filter (present/absent/mismatched)", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("keeps only tasks whose priority is in the requested set", async () => {
    v = makeM4Vault({
      files: {
        [NOTE]: ["- [ ] high one ⏫", "- [ ] low one 🔽", "- [ ] no priority"].join("\n"),
      },
    });
    const res = await v.call("list_tasks", { vault: "test", priority: ["high"] });
    const items = data(res).items as Record<string, unknown>[];
    expect(items.map((t) => t.description)).toEqual(["high one"]);
  });
});

describe("list_tasks — tags with a leading '#' already present", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("matches when the requested tag already starts with '#'", async () => {
    v = makeM4Vault({
      files: { [NOTE]: ["- [ ] tagged #work", "- [ ] untagged"].join("\n") },
    });
    const res = await v.call("list_tasks", { vault: "test", tags: ["#work"] });
    const items = data(res).items as Record<string, unknown>[];
    expect(items.map((t) => t.description)).toEqual(["tagged #work"]);
  });
});

describe("list_tasks — explicit `paths` combined with `root` scoping", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("uses the explicit paths list (bypassing walkVault) and still applies root scoping", async () => {
    v = makeM4Vault({
      files: {
        "Notes/todo.md": "- [ ] inside notes",
        "Other/todo.md": "- [ ] outside notes",
      },
    });
    const res = await v.call("list_tasks", {
      vault: "test",
      paths: ["Notes/todo.md", "Other/todo.md"],
      root: "Notes",
    });
    const items = data(res).items as Record<string, unknown>[];
    expect(items.map((t) => t.path)).toEqual(["Notes/todo.md"]);
  });

  it("keeps a path that equals `root` exactly (rel === sub), not just a prefix match", async () => {
    v = makeM4Vault({
      files: {
        "Notes/todo.md": "- [ ] the exact file",
        "Other/todo.md": "- [ ] a different file",
      },
    });
    const res = await v.call("list_tasks", {
      vault: "test",
      paths: ["Notes/todo.md", "Other/todo.md"],
      root: "Notes/todo.md",
    });
    const items = data(res).items as Record<string, unknown>[];
    expect(items.map((t) => t.path)).toEqual(["Notes/todo.md"]);
  });
});

describe("update_task — eol preservation, out-of-range line, omitted set", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("preserves CRLF line endings when rewriting the file", async () => {
    v = makeM4Vault({});
    v.write(NOTE, "- [ ] a\r\n- [ ] b\r\n");
    const res = await v.call("update_task", {
      vault: "test",
      path: NOTE,
      line: 1,
      set: { status: "done" },
    });
    expect(res.ok).toBe(true);
    const raw = v.read(NOTE);
    expect(raw).toContain("\r\n");
    expect(raw.split("\r\n")[0]).toBe("- [x] a");
  });

  it("reports invalid_input for a line number beyond the end of the file", async () => {
    v = makeM4Vault({ files: { [NOTE]: "- [ ] only line\n" } });
    const res = await v.call("update_task", {
      vault: "test",
      path: NOTE,
      line: 99,
      set: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_input");
  });

  it("succeeds with an omitted `set`, leaving the task unchanged", async () => {
    v = makeM4Vault({ files: { [NOTE]: "- [ ] untouched task" } });
    const res = await v.call("update_task", { vault: "test", path: NOTE, line: 1 });
    expect(res.ok).toBe(true);
    const d = data(res);
    const prev = d.prev_state as Record<string, unknown>;
    const next = d.new_state as Record<string, unknown>;
    expect(next.status).toBe(prev.status);
    expect(next.description).toBe(prev.description);
    expect(v.read(NOTE)).toBe("- [ ] untouched task");
  });
});

describe("tasks_filter — optional sort_by/limit/cursor forwarded to the bridge", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("includes sort_by, limit, and cursor in the bridge request body when provided", async () => {
    v = makeM4Vault({
      installed: ["tasks"],
      routes: {
        "POST /obsidian-tc/v1/tasks/filter": {
          body: { ok: true, result: { items: [] } },
        },
      },
    });
    const res = await v.call("tasks_filter", {
      vault: "test",
      filter: "not done",
      sort_by: "priority",
      limit: 5,
      cursor: "abc",
    });
    expect(res.ok).toBe(true);
    const req = v.bridgeRequests[0];
    if (!req) throw new Error("expected a bridge request");
    const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
    expect(body.sort_by).toBe("priority");
    expect(body.limit).toBe(5);
    expect(body.cursor).toBe("abc");
  });
});

describe("tasks_filter — bridge response without an `items` array", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("degrades to an empty item list instead of throwing", async () => {
    v = makeM4Vault({
      installed: ["tasks"],
      routes: {
        "POST /obsidian-tc/v1/tasks/filter": {
          body: { ok: true, result: { groups: [{ key: "x", count: 3 }] } },
        },
      },
    });
    const res = await v.call("tasks_filter", { vault: "test", filter: "done" });
    expect(res.ok).toBe(true);
    const d = data(res);
    expect(d.items).toEqual([]);
    expect(d.total).toBe(0);
  });
});
