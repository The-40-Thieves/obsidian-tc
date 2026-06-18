// Domain 10 — Dataview standalone proxy tools through dispatch against the fake
// bridge. Covers the happy path, the degradation gate, ACL on the eval path, and
// the dql_error envelope passthrough (proving the transport maps a bridge-reported
// DQL error onto our taxonomy rather than collapsing it to plugin_unreachable).
import { afterEach, describe, expect, it } from "vitest";
import type { FakeRequestInfo } from "../src/bridge";
import { type M4Vault, makeM4Vault } from "./m4-helpers";

function bodyOf(v: M4Vault, i: number): Record<string, unknown> {
  const req: FakeRequestInfo | undefined = v.bridgeRequests[i];
  if (!req) throw new Error(`expected a bridge request at index ${i}`);
  return JSON.parse(req.body ?? "{}") as Record<string, unknown>;
}

describe("validate_dql", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("parses a query via the bridge and returns the AST", async () => {
    v = makeM4Vault({
      installed: ["dataview"],
      routes: {
        "POST /obsidian-tc/v1/dataview/validate": {
          body: { ok: true, result: { valid: true, ast: { kind: "table" } } },
        },
      },
    });
    const res = await v.call("validate_dql", { vault: "test", dql: "TABLE file.name" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as Record<string, unknown>;
      expect(data.valid).toBe(true);
      expect(data.ast).toEqual({ kind: "table" });
    }
    expect(bodyOf(v, 0).dql).toBe("TABLE file.name");
  });

  it("degrades to plugin_missing when Dataview is not installed", async () => {
    v = makeM4Vault({ installed: [] });
    const res = await v.call("validate_dql", { vault: "test", dql: "LIST" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_missing");
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("surfaces a bridge dql_error verbatim (taxonomy passthrough)", async () => {
    v = makeM4Vault({
      installed: ["dataview"],
      routes: {
        "POST /obsidian-tc/v1/dataview/validate": {
          status: 200,
          body: { ok: false, code: "dql_error", message: "unexpected token at col 4" },
        },
      },
    });
    const res = await v.call("validate_dql", { vault: "test", dql: "TABLZ" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("dql_error");
  });
});

describe("eval_dataview_field", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("evaluates an expression against a note via the bridge", async () => {
    v = makeM4Vault({
      installed: ["dataview"],
      routes: {
        "POST /obsidian-tc/v1/dataview/eval": {
          body: { ok: true, result: { value: 42, type: "number" } },
        },
      },
    });
    const res = await v.call("eval_dataview_field", {
      vault: "test",
      path: "Notes/A.md",
      expression: "length(file.tasks)",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as Record<string, unknown>;
      expect(data.value).toBe(42);
      expect(data.type).toBe("number");
      expect(data.path).toBe("Notes/A.md");
    }
    const body = bodyOf(v, 0);
    expect(body.path).toBe("Notes/A.md");
    expect(body.expression).toBe("length(file.tasks)");
  });

  it("enforces the read ACL before reaching the bridge", async () => {
    v = makeM4Vault({ installed: ["dataview"], acl: { readPaths: ["Allowed/**"] } });
    const res = await v.call("eval_dataview_field", {
      vault: "test",
      path: "Notes/A.md",
      expression: "1 + 1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("acl_denied");
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("degrades to plugin_unreachable when the companion did not answer the probe", async () => {
    v = makeM4Vault({ snapshot: { companion: "unreachable", plugins: {} } });
    const res = await v.call("eval_dataview_field", {
      vault: "test",
      path: "Notes/A.md",
      expression: "1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_unreachable");
  });
});
