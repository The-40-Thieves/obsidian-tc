// Domain 26 — Command palette. list_commands is a read-side companion enumeration.
// execute_command is the most dangerous M4 tool: deny-by-default and triple-gated
// (execute:command HITL floor + per-vault enable + allowlist). These tests prove all
// three gates and that the companion (not a community plugin) is what's required.
import { afterEach, describe, expect, it } from "vitest";
import { type M4Vault, makeM4Vault } from "./m4-helpers";

const enabled = (allowlist: string[]) => () => ({ enabled: true, allowlist });

describe("list_commands", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("enumerates commands via the companion", async () => {
    v = makeM4Vault({
      routes: {
        "POST /obsidian-tc/v1/commands/list": {
          body: { ok: true, result: { items: [{ id: "editor:save-file", name: "Save" }] } },
        },
      },
    });
    const res = await v.call("list_commands", { vault: "test", filter: "save" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(((res.data as Record<string, unknown>).items as unknown[]).length).toBe(1);
    const req = v.bridgeRequests[0];
    if (!req) throw new Error("expected a bridge request");
    expect((JSON.parse(req.body ?? "{}") as Record<string, unknown>).filter).toBe("save");
  });

  it("degrades to plugin_unreachable when the companion is absent", async () => {
    v = makeM4Vault({ snapshot: { companion: "missing", plugins: {} } });
    const res = await v.call("list_commands", { vault: "test" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_unreachable");
  });
});

describe("execute_command (deny-by-default, triple-gated)", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  const input = { vault: "test", command_id: "editor:save-file" };
  const routes = {
    "POST /obsidian-tc/v1/commands/execute": {
      body: { ok: true, result: { fired_at: "t", plugin_response: { ok: true } } },
    },
  };

  it("gate 1 — HITL floor: no elicit token => elicit_required before any policy/bridge call", async () => {
    v = makeM4Vault({ routes, commandPolicy: enabled(["editor:save-file"]) });
    const res = await v.call("execute_command", input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("elicit_required");
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("gate 2 — disabled by default: confirmed but execution not enabled => execute_command_disabled", async () => {
    v = makeM4Vault({ routes }); // no commandPolicy => disabled
    const res = await v.callConfirmed("execute_command", input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("execute_command_disabled");
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("gate 3 — allowlist: enabled but id not allowlisted => command_not_allowlisted", async () => {
    v = makeM4Vault({ routes, commandPolicy: enabled(["app:reload"]) });
    const res = await v.callConfirmed("execute_command", input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("command_not_allowlisted");
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("a precheck rejection (disabled) does NOT consume the elicit token (E2/D5)", async () => {
    v = makeM4Vault({ routes }); // disabled
    const denied = await v.callConfirmed("execute_command", input);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("execute_command_disabled");
    // precheck runs before the HITL stage, so the minted token is left unconsumed.
    const row = v.db
      .prepare("SELECT consumed_at FROM elicit_tokens ORDER BY rowid DESC LIMIT 1")
      .get() as { consumed_at: number | null } | undefined;
    expect(row?.consumed_at).toBeNull();
  });

  it("fires only when confirmed AND enabled AND allowlisted", async () => {
    v = makeM4Vault({ routes, commandPolicy: enabled(["editor:save-file"]) });
    const res = await v.callConfirmed("execute_command", input);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as Record<string, unknown>).command_id).toBe("editor:save-file");
    const req = v.bridgeRequests[0];
    if (!req) throw new Error("expected a bridge request");
    expect((JSON.parse(req.body ?? "{}") as Record<string, unknown>).command_id).toBe(
      "editor:save-file",
    );
  });

  it("degrades to plugin_unreachable when the companion is absent (all gates passed)", async () => {
    v = makeM4Vault({
      snapshot: { companion: "unreachable", plugins: {} },
      commandPolicy: enabled(["editor:save-file"]),
    });
    const res = await v.callConfirmed("execute_command", input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_unreachable");
  });
});

describe("LRA-native command fallback (#155 / THE-383)", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  const enc = (id: string) => encodeURIComponent(id);

  it("list_commands falls back to LRA /commands/ when the companion is unreachable", async () => {
    v = makeM4Vault({
      snapshot: { companion: "unreachable", plugins: {} },
      routes: {
        "GET /commands/": {
          body: {
            commands: [
              { id: "editor:save-file", name: "Save current file" },
              { id: "app:reload", name: "Reload app" },
            ],
          },
        },
      },
    });
    const res = await v.call("list_commands", { vault: "test", filter: "save" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as Record<string, unknown>;
      expect(data.source).toBe("local-rest-api");
      const items = data.items as { id: string }[];
      expect(items.map((c) => c.id)).toEqual(["editor:save-file"]);
    }
    expect(v.bridgeRequests.some((r) => new URL(r.url).pathname === "/commands/")).toBe(true);
  });

  it("list_commands surfaces the companion degrade when LRA is also unreachable", async () => {
    v = makeM4Vault({
      snapshot: { companion: "unreachable", plugins: {} },
      routes: { "GET /commands/": { networkError: true } },
    });
    const res = await v.call("list_commands", { vault: "test" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_unreachable");
  });

  it("execute_command falls back to LRA /commands/{id}/ when the companion is unreachable", async () => {
    const id = "editor:save-file";
    v = makeM4Vault({
      snapshot: { companion: "unreachable", plugins: {} },
      commandPolicy: () => ({ enabled: true, allowlist: [id] }),
      routes: { [`POST /commands/${enc(id)}/`]: { status: 204 } },
    });
    const res = await v.callConfirmed("execute_command", { vault: "test", command_id: id });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as Record<string, unknown>;
      expect(data.command_id).toBe(id);
      expect(data.source).toBe("local-rest-api");
    }
    expect(
      v.bridgeRequests.some(
        (r) => r.method === "POST" && new URL(r.url).pathname === `/commands/${enc(id)}/`,
      ),
    ).toBe(true);
  });

  it("the native fallback never bypasses the allowlist gate", async () => {
    const id = "editor:save-file";
    v = makeM4Vault({
      snapshot: { companion: "unreachable", plugins: {} },
      commandPolicy: () => ({ enabled: true, allowlist: ["app:reload"] }),
      routes: { [`POST /commands/${enc(id)}/`]: { status: 204 } },
    });
    const res = await v.callConfirmed("execute_command", { vault: "test", command_id: id });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("command_not_allowlisted");
    expect(v.bridgeRequests).toHaveLength(0);
  });
});
