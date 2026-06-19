// Domain 11 — Tasks. list_tasks / update_task are filesystem (parse + edit Markdown
// task lines, no plugin); tasks_filter proxies the Tasks DSL through the bridge.
// Covers parsing/filtering, in-place edit with content_hash + prev/new state, the
// reopen-stale conditional HITL, line/not-found errors, ACL, and bridge degradation.
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { type M4Vault, makeM4Vault } from "./m4-helpers";

const NOTE = "Notes/todo.md";
const CONTENT = [
  "# Tasks",
  "",
  "- [ ] write report 📅 2026-06-20 #work ⏫",
  "- [x] buy milk ✅ 2026-06-01 #errand",
  "- [/] draft spec 🔽",
  "not a task",
  "- [x] ancient thing ✅ 2000-01-01",
  "",
].join("\n");

function data(res: ToolResult): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected ok result, got ${res.error.code}`);
  return res.data as Record<string, unknown>;
}

describe("list_tasks", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("parses tasks and reports typed fields with 1-based line numbers", async () => {
    v = makeM4Vault({ files: { [NOTE]: CONTENT } });
    const res = await v.call("list_tasks", { vault: "test" });
    expect(res.ok).toBe(true);
    const items = data(res).items as Record<string, unknown>[];
    // Three real tasks on lines 3/4/5 plus the ancient one on line 7.
    expect(items).toHaveLength(4);
    const first = items[0] as Record<string, unknown>;
    expect(first.status).toBe("todo");
    expect(first.line).toBe(3);
    expect(first.due).toBe("2026-06-20");
    expect(first.priority).toBe("high");
    expect(first.tags).toEqual(["#work"]);
  });

  it("filters by status", async () => {
    v = makeM4Vault({ files: { [NOTE]: CONTENT } });
    const res = await v.call("list_tasks", { vault: "test", status: ["in_progress"] });
    const items = data(res).items as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect((items[0] as Record<string, unknown>).priority).toBe("low");
  });

  it("filters by tag (with or without leading #) and by due range", async () => {
    v = makeM4Vault({ files: { [NOTE]: CONTENT } });
    const byTag = await v.call("list_tasks", { vault: "test", tags: ["work"] });
    expect((data(byTag).items as unknown[]).length).toBe(1);
    const byDue = await v.call("list_tasks", {
      vault: "test",
      due: { before: "2026-06-25" },
    });
    expect((data(byDue).items as unknown[]).length).toBe(1);
  });

  it("excludes notes outside the read ACL whitelist", async () => {
    v = makeM4Vault({
      files: { [NOTE]: CONTENT, "Secret/s.md": "- [ ] hidden task" },
      acl: { readPaths: ["Notes/**"] },
    });
    const res = await v.call("list_tasks", { vault: "test" });
    const items = data(res).items as Record<string, unknown>[];
    expect(items.every((t) => String(t.path).startsWith("Notes/"))).toBe(true);
  });
});

describe("update_task", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("toggles status in place and reports prev/new state + content_hash", async () => {
    v = makeM4Vault({ files: { [NOTE]: CONTENT } });
    const res = await v.call("update_task", {
      vault: "test",
      path: NOTE,
      line: 3,
      set: { status: "done" },
    });
    expect(res.ok).toBe(true);
    const d = data(res);
    expect((d.prev_state as Record<string, unknown>).status).toBe("todo");
    expect((d.new_state as Record<string, unknown>).status).toBe("done");
    expect(typeof d.content_hash).toBe("string");
    expect(v.read(NOTE).split("\n")[2]).toContain("- [x] write report");
  });

  it("rejects a line that is not a task", async () => {
    v = makeM4Vault({ files: { [NOTE]: CONTENT } });
    const res = await v.call("update_task", { vault: "test", path: NOTE, line: 1, set: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_input");
  });

  it("reports note_not_found for a missing note", async () => {
    v = makeM4Vault({ files: { [NOTE]: CONTENT } });
    const res = await v.call("update_task", {
      vault: "test",
      path: "Notes/nope.md",
      line: 1,
      set: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("note_not_found");
  });

  it("requires confirmation to reopen a task completed long ago, then succeeds", async () => {
    v = makeM4Vault({ files: { [NOTE]: CONTENT } });
    // Line 7 is the ancient ✅ 2000-01-01 done task.
    const input = { vault: "test", path: NOTE, line: 7, set: { status: "todo" } };
    const denied = await v.call("update_task", input);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("elicit_required");

    const ok = await v.callConfirmed("update_task", input);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect((data(ok).new_state as Record<string, unknown>).status).toBe("todo");
  });
});

describe("tasks_filter", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("proxies a filter expression to the bridge", async () => {
    v = makeM4Vault({
      installed: ["tasks"],
      routes: {
        "POST /obsidian-tc/v1/tasks/filter": {
          body: {
            ok: true,
            result: { items: [{ path: "A.md", line: 1 }], groups: [{ key: "x", count: 1 }] },
          },
        },
      },
    });
    const res = await v.call("tasks_filter", {
      vault: "test",
      filter: "not done",
      group_by: "status",
    });
    expect(res.ok).toBe(true);
    const d = data(res);
    expect((d.items as unknown[]).length).toBe(1);
    const req = v.bridgeRequests[0];
    if (!req) throw new Error("expected a bridge request");
    const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
    expect(body.filter).toBe("not done");
    expect(body.group_by).toBe("status");
  });

  it("degrades to plugin_missing when the Tasks plugin is absent", async () => {
    v = makeM4Vault({ installed: [] });
    const res = await v.call("tasks_filter", { vault: "test", filter: "done" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_missing");
    expect(v.bridgeRequests).toHaveLength(0);
  });
});
