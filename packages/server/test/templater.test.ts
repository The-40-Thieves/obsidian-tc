// Domain 13 — Templater. list_templates is a plain read-side bridge call;
// execute_template carries write:templater, a HITL floor, so dispatch ALWAYS
// demands an elicit token before the handler runs (no silent template execution).
import { afterEach, describe, expect, it } from "vitest";
import { type M4Vault, makeM4Vault } from "./m4-helpers";

describe("list_templates", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("lists templates via the bridge (no confirmation needed)", async () => {
    v = makeM4Vault({
      installed: ["templater"],
      routes: {
        "POST /obsidian-tc/v1/templater/list": {
          body: { ok: true, result: { items: [{ path: "Templates/daily.md", name: "daily" }] } },
        },
      },
    });
    const res = await v.call("list_templates", { vault: "test" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(((res.data as Record<string, unknown>).items as unknown[]).length).toBe(1);
  });

  it("degrades to plugin_missing when Templater is absent", async () => {
    v = makeM4Vault({ installed: [] });
    const res = await v.call("list_templates", { vault: "test" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_missing");
  });
});

describe("execute_template", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  const input = { vault: "test", template: "Templates/daily.md", target: "Daily/2026-06-18.md" };
  const routes = {
    "POST /obsidian-tc/v1/templater/execute": {
      body: { ok: true, result: { created_at: "t", content_hash: "h", expanded_size: 42 } },
    },
  };

  it("is HITL-floored: no elicit token => elicit_required before any bridge call", async () => {
    v = makeM4Vault({ installed: ["templater"], routes });
    const res = await v.call("execute_template", input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("elicit_required");
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("runs the template and writes output with a valid elicit token", async () => {
    v = makeM4Vault({ installed: ["templater"], routes });
    const res = await v.callConfirmed("execute_template", input);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as Record<string, unknown>).expanded_size).toBe(42);
    const req = v.bridgeRequests[0];
    if (!req) throw new Error("expected a bridge request");
    const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
    expect(body.template).toBe("Templates/daily.md");
    expect(body.target).toBe("Daily/2026-06-18.md");
    expect(body.overwrite).toBe(false);
  });

  it("enforces the target write ACL (after confirmation, before the bridge)", async () => {
    v = makeM4Vault({ installed: ["templater"], routes, acl: { writePaths: ["Allowed/**"] } });
    const res = await v.callConfirmed("execute_template", input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("acl_denied");
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("degrades to plugin_missing when Templater is absent (token present)", async () => {
    v = makeM4Vault({ installed: [] });
    const res = await v.callConfirmed("execute_template", input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_missing");
  });
});
