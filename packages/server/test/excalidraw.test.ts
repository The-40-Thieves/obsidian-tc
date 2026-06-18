// Domain 9 — Excalidraw proxy tools, end-to-end through dispatch against the
// deterministic fake bridge (no live Obsidian, no companion runtime, no community
// plugin). Exercises the happy path, the degradation gate (plugin_missing /
// plugin_unreachable from the probed snapshot), conditional HITL on overwrite, the
// transport failure mapping, ACL enforcement, and the security invariant that the
// bridge bearer token reaches the transport header but never an error payload.
import { afterEach, describe, expect, it } from "vitest";
import type { FakeRequestInfo } from "../src/bridge";
import { type M4Vault, makeM4Vault } from "./m4-helpers";

const DRAWING = "Drawings/Plan.excalidraw.md";

function reqAt(v: M4Vault, i: number): FakeRequestInfo {
  const r = v.bridgeRequests[i];
  if (!r) throw new Error(`expected a bridge request at index ${i}`);
  return r;
}

function bodyOf(req: FakeRequestInfo): Record<string, unknown> {
  return JSON.parse(req.body ?? "{}") as Record<string, unknown>;
}

describe("read_excalidraw", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("proxies to /excalidraw/read and merges the bridge result", async () => {
    v = makeM4Vault({
      installed: ["excalidraw"],
      routes: {
        "POST /obsidian-tc/v1/excalidraw/read": {
          body: { ok: true, result: { elements: [{ id: "a" }], text: "hello" } },
        },
      },
    });

    const res = await v.call("read_excalidraw", { vault: "test", path: DRAWING });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as Record<string, unknown>;
      expect(data.vault).toBe("test");
      expect(data.path).toBe(DRAWING);
      expect(data.text).toBe("hello");
      expect(data.elements).toEqual([{ id: "a" }]);
    }

    const req = reqAt(v, 0);
    expect(req.method).toBe("POST");
    expect(req.url.endsWith("/obsidian-tc/v1/excalidraw/read")).toBe(true);
    // The bearer token reaches the transport header...
    expect(req.headers.authorization).toBe("Bearer test-key");
    const body = bodyOf(req);
    expect(body.path).toBe(DRAWING);
    expect(body.format).toBe("both");
  });

  it("degrades to plugin_missing when Excalidraw is not installed (no network call)", async () => {
    v = makeM4Vault({ installed: ["dataview"] });
    const res = await v.call("read_excalidraw", { vault: "test", path: DRAWING });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_missing");
    // The degradation gate fires before any request is dispatched.
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("degrades to plugin_missing when the companion is absent", async () => {
    v = makeM4Vault({ snapshot: { companion: "missing", plugins: {} } });
    const res = await v.call("read_excalidraw", { vault: "test", path: DRAWING });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_missing");
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("degrades to plugin_unreachable when the companion did not answer the probe", async () => {
    v = makeM4Vault({ snapshot: { companion: "unreachable", plugins: {} } });
    const res = await v.call("read_excalidraw", { vault: "test", path: DRAWING });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_unreachable");
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("maps a transport failure to plugin_unreachable without leaking the token", async () => {
    v = makeM4Vault({
      installed: ["excalidraw"],
      routes: { "POST /obsidian-tc/v1/excalidraw/read": { networkError: true } },
    });
    const res = await v.call("read_excalidraw", { vault: "test", path: DRAWING });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("plugin_unreachable");
      expect(res.error.details).toEqual({ plugin: "excalidraw" });
    }
    // ...but the bearer token never appears anywhere in the surfaced error.
    expect(JSON.stringify(res)).not.toContain("test-key");
  });

  it("enforces the read ACL before reaching the bridge", async () => {
    v = makeM4Vault({ installed: ["excalidraw"], acl: { readPaths: ["Allowed/**"] } });
    const res = await v.call("read_excalidraw", { vault: "test", path: DRAWING });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("acl_denied");
    expect(v.bridgeRequests).toHaveLength(0);
  });
});

describe("create_excalidraw", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("creates a drawing without confirmation when not overwriting", async () => {
    v = makeM4Vault({
      installed: ["excalidraw"],
      routes: {
        "POST /obsidian-tc/v1/excalidraw/write": { body: { ok: true, result: { created: true } } },
      },
    });
    const res = await v.call("create_excalidraw", { vault: "test", path: DRAWING });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as Record<string, unknown>).created).toBe(true);
    const body = bodyOf(reqAt(v, 0));
    expect(body.mode).toBe("create");
    expect(body.overwrite).toBe(false);
  });

  it("requires confirmation to overwrite, then succeeds with a valid elicit token", async () => {
    v = makeM4Vault({
      installed: ["excalidraw"],
      routes: {
        "POST /obsidian-tc/v1/excalidraw/write": { body: { ok: true, result: { created: true } } },
      },
    });
    const input = { vault: "test", path: DRAWING, overwrite: true };

    const denied = await v.call("create_excalidraw", input);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("elicit_required");
    // No request is dispatched until the human confirms.
    expect(v.bridgeRequests).toHaveLength(0);

    const ok = await v.callConfirmed("create_excalidraw", input);
    expect(ok.ok).toBe(true);
    const body = bodyOf(reqAt(v, 0));
    expect(body.mode).toBe("create");
    expect(body.overwrite).toBe(true);
  });
});

describe("update_excalidraw", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("proxies element edits to /excalidraw/write in update mode", async () => {
    v = makeM4Vault({
      installed: ["excalidraw"],
      routes: {
        "POST /obsidian-tc/v1/excalidraw/write": { body: { ok: true, result: { updated: 1 } } },
      },
    });
    const res = await v.call("update_excalidraw", {
      vault: "test",
      path: DRAWING,
      add_elements: [{ id: "b", type: "rectangle" }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as Record<string, unknown>).updated).toBe(1);
    const body = bodyOf(reqAt(v, 0));
    expect(body.mode).toBe("update");
    expect(body.add_elements).toEqual([{ id: "b", type: "rectangle" }]);
  });
});
