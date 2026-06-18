// Domain 17 — make.md. Two read-side bridge tools; the plugin capability key is
// "make-md" (hyphen). Covers proxy success, body forwarding, and degradation.
import { afterEach, describe, expect, it } from "vitest";
import { type M4Vault, makeM4Vault } from "./m4-helpers";

describe("makemd_list_spaces", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("lists spaces via the bridge", async () => {
    v = makeM4Vault({
      installed: ["make-md"],
      routes: {
        "POST /obsidian-tc/v1/makemd/spaces": {
          body: { ok: true, result: { spaces: [{ id: "s1", name: "Inbox", view_count: 2 }] } },
        },
      },
    });
    const res = await v.call("makemd_list_spaces", { vault: "test" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(((res.data as Record<string, unknown>).spaces as unknown[]).length).toBe(1);
  });

  it("degrades to plugin_missing when make-md is absent", async () => {
    v = makeM4Vault({ installed: [] });
    const res = await v.call("makemd_list_spaces", { vault: "test" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_missing");
  });
});

describe("makemd_query", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("queries a space and forwards the space_id", async () => {
    v = makeM4Vault({
      installed: ["make-md"],
      routes: {
        "POST /obsidian-tc/v1/makemd/query": {
          body: {
            ok: true,
            result: { items: [{ note_path: "A.md", columns: { x: 1 } }], total: 1 },
          },
        },
      },
    });
    const res = await v.call("makemd_query", {
      vault: "test",
      space_id: "s1",
      filter: { tag: "x" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as Record<string, unknown>).space_id).toBe("s1");
    const req = v.bridgeRequests[0];
    if (!req) throw new Error("expected a bridge request");
    const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
    expect(body.space_id).toBe("s1");
    expect(body.filter).toEqual({ tag: "x" });
  });

  it("degrades to plugin_unreachable when the companion did not answer the probe", async () => {
    v = makeM4Vault({ snapshot: { companion: "unreachable", plugins: {} } });
    const res = await v.call("makemd_query", { vault: "test", space_id: "s1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_unreachable");
  });
});
