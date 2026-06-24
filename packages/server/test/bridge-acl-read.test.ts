import { afterEach, describe, expect, it } from "vitest";
import type { AclConfigT } from "../src/acl";
import { type M4Vault, makeM4Vault } from "./m4-helpers";

describe("bridge read-ACL filtering (D2)", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  const tasksVault = (acl?: Partial<AclConfigT>) =>
    makeM4Vault({
      installed: ["tasks"],
      ...(acl ? { acl } : {}),
      routes: {
        "POST /obsidian-tc/v1/tasks/filter": {
          body: {
            ok: true,
            result: {
              items: [
                { path: "Notes/a.md", line: 1 },
                { path: "Secret/s.md", line: 2 },
              ],
              groups: [{ key: "x", count: 2 }],
            },
          },
        },
      },
    });

  it("tasks_filter drops items outside the read whitelist and keeps groups", async () => {
    v = tasksVault({ readPaths: ["Notes/**"] });
    const res = await v.call("tasks_filter", { vault: "test", filter: "done" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { items: { path: string }[]; total: number; groups: unknown[] };
      expect(d.items).toEqual([{ path: "Notes/a.md", line: 1 }]);
      expect(d.total).toBe(1);
      expect(d.groups).toEqual([{ key: "x", count: 2 }]);
    }
  });

  it("tasks_filter returns all items when readPaths is undefined (M0 back-compat)", async () => {
    v = tasksVault();
    const res = await v.call("tasks_filter", { vault: "test", filter: "done" });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { items: unknown[] }).items.length).toBe(2);
  });

  it("tasks_filter fails closed when readPaths defined and a row lacks a path", async () => {
    v = makeM4Vault({
      installed: ["tasks"],
      acl: { readPaths: ["Notes/**"] },
      routes: {
        "POST /obsidian-tc/v1/tasks/filter": {
          body: { ok: true, result: { items: [{ line: 1 }] } },
        },
      },
    });
    const res = await v.call("tasks_filter", { vault: "test", filter: "done" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("acl_denied");
  });

  it("makemd_query filters rows by note_path under a read whitelist", async () => {
    v = makeM4Vault({
      installed: ["make-md"],
      acl: { readPaths: ["Notes/**"] },
      routes: {
        "POST /obsidian-tc/v1/makemd/query": {
          body: {
            ok: true,
            result: { items: [{ note_path: "Notes/a.md" }, { note_path: "Secret/s.md" }] },
          },
        },
      },
    });
    const res = await v.call("makemd_query", { vault: "test", space_id: "s1" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { items: { note_path: string }[] };
      expect(d.items).toEqual([{ note_path: "Notes/a.md" }]);
    }
  });

  it("makemd_list_spaces is refused under a read whitelist before hitting the bridge", async () => {
    v = makeM4Vault({
      installed: ["make-md"],
      acl: { readPaths: ["Notes/**"] },
      routes: {
        "POST /obsidian-tc/v1/makemd/spaces": {
          body: { ok: true, result: { spaces: [{ id: "s1" }] } },
        },
      },
    });
    const res = await v.call("makemd_list_spaces", { vault: "test" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("acl_denied");
    expect(v.bridgeRequests.length).toBe(0);
  });

  it("makemd_list_spaces succeeds when readPaths is undefined", async () => {
    v = makeM4Vault({
      installed: ["make-md"],
      routes: {
        "POST /obsidian-tc/v1/makemd/spaces": {
          body: { ok: true, result: { spaces: [{ id: "s1" }] } },
        },
      },
    });
    const res = await v.call("makemd_list_spaces", { vault: "test" });
    expect(res.ok).toBe(true);
  });
});
