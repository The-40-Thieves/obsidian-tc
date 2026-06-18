// Domain 14 — QuickAdd. list_quickadd_actions is read-side; trigger_quickadd is
// execute:quickadd (HITL floor), so dispatch demands an elicit token before the
// handler runs — no silent action firing.
import { afterEach, describe, expect, it } from "vitest";
import { type M4Vault, makeM4Vault } from "./m4-helpers";

describe("list_quickadd_actions", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("enumerates actions via the bridge", async () => {
    v = makeM4Vault({
      installed: ["quickadd"],
      routes: {
        "POST /obsidian-tc/v1/quickadd/actions": {
          body: { ok: true, result: { items: [{ name: "Add Note", type: "template" }] } },
        },
      },
    });
    const res = await v.call("list_quickadd_actions", { vault: "test" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(((res.data as Record<string, unknown>).items as unknown[]).length).toBe(1);
  });

  it("degrades to plugin_missing when QuickAdd is absent", async () => {
    v = makeM4Vault({ installed: [] });
    const res = await v.call("list_quickadd_actions", { vault: "test" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_missing");
  });
});

describe("trigger_quickadd", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  const input = { vault: "test", action_name: "Capture Idea" };
  const routes = {
    "POST /obsidian-tc/v1/quickadd/trigger": {
      body: { ok: true, result: { fired_at: "t", created_paths: ["Inbox/idea.md"] } },
    },
  };

  it("is HITL-floored: no elicit token => elicit_required before any bridge call", async () => {
    v = makeM4Vault({ installed: ["quickadd"], routes });
    const res = await v.call("trigger_quickadd", input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("elicit_required");
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("fires the action with a valid elicit token", async () => {
    v = makeM4Vault({ installed: ["quickadd"], routes });
    const res = await v.callConfirmed("trigger_quickadd", input);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as Record<string, unknown>;
      expect(data.action_name).toBe("Capture Idea");
      expect(data.created_paths).toEqual(["Inbox/idea.md"]);
    }
    const req = v.bridgeRequests[0];
    if (!req) throw new Error("expected a bridge request");
    expect((JSON.parse(req.body ?? "{}") as Record<string, unknown>).action_name).toBe(
      "Capture Idea",
    );
  });

  it("degrades to plugin_missing when QuickAdd is absent (token present)", async () => {
    v = makeM4Vault({ installed: [] });
    const res = await v.callConfirmed("trigger_quickadd", input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_missing");
  });
});
