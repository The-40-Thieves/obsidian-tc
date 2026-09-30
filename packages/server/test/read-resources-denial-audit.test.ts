// read_resources turns a per-URI denial into an `ok: false` item inside a SUCCESSFUL call, so the
// dispatch-level denial signals (audit row, acl_denied metric, tc.acl.denied) that read_notes gets
// from its thrown acl_denied never fired for it. Each denied item must emit the same records
// read_notes emits for a denied path, without telling an unauthorized caller whether a hidden
// note exists. Also pins that the gates keyed elsewhere (rate limit, read-only, visibility) still
// apply to a tool that declares no central `pathAcl`.
import { afterEach, describe, expect, it } from "vitest";
import { buildResourceUri } from "../src/mcp/resources";
import { ALLOW_ALL } from "../src/mcp/visibility";
import { MetricsRecorder } from "../src/metrics/registry";
import { RateLimiter } from "../src/throttle";
import { makeTestVault, type TestVault } from "./m1-helpers";

const vaults: TestVault[] = [];
afterEach(() => {
  for (const v of vaults.splice(0)) v.cleanup();
});

const ACL = { readPaths: ["pub/**"] };
const uri = (rel: string, vaultId = "test") => buildResourceUri(vaultId, rel);

interface Emitted {
  type: string;
  data: Record<string, unknown>;
}
function vault(files: Record<string, string>, over: Parameters<typeof makeTestVault>[0] = {}) {
  const emitted: Emitted[] = [];
  const metrics = new MetricsRecorder();
  const v = makeTestVault({
    files,
    centralAcl: true,
    acl: ACL,
    metrics,
    ...over,
    registryOpts: {
      metrics,
      emit: (_vid, type, data) => emitted.push({ type, data: data as Record<string, unknown> }),
      ...over.registryOpts,
    },
  });
  vaults.push(v);
  return { v, emitted, metrics };
}

const FILES = { "pub/a.md": "A", "secret/b.md": "B", "pub/sub/x.md": "X" };

describe("read_resources: denied items emit the denial records read_notes emits", () => {
  it("baseline: read_notes on a denied path audits error/acl_denied, counts it and relays tc.acl.denied", async () => {
    const { v, emitted, metrics } = vault(FILES);
    const r = await v.call("read_notes", { vault: "test", paths: ["secret/b.md"] });
    expect(r.ok).toBe(false);
    expect(v.events()).toEqual([
      {
        tool_name: "read_notes",
        status: "error",
        error_code: "acl_denied",
        event_type: expect.any(String),
      },
    ]);
    expect(emitted.filter((e) => e.type === "tc.acl.denied")).toHaveLength(1);
    expect(await metrics.metrics()).toMatch(
      /obsidian_tc_acl_denied_total\{vault="test",scope_class="read",reason="acl_denied"\} 1/,
    );
  });

  it("a batch with denied items still succeeds, and each denied item is audited, counted and relayed", async () => {
    const { v, emitted, metrics } = vault(FILES);
    const baseline = await v.call("read_notes", { vault: "test", paths: ["secret/b.md"] });
    expect(baseline.ok).toBe(false);
    const readNotesRow = v.events()[0];
    emitted.length = 0;

    const r = await v.call("read_resources", {
      uris: [
        uri("pub/a.md"), // ok
        uri("secret/b.md"), // denied (exists)
        uri("secret/none.md"), // denied (absent)
        uri("pub/none.md"), // missing under an allowed path: NOT a denial
        uri("x.md", "other"), // foreign vault: forbidden, counted like dispatch counts it
        "obsidian-tc://test/50%.md", // malformed: NOT a denial
      ],
    });
    expect(r.ok).toBe(true);
    const rows = v.events().filter((e) => e.tool_name === "read_resources");
    const denialRows = rows.filter((e) => e.status === "error");
    expect(denialRows.map((e) => e.error_code).sort()).toEqual([
      "acl_denied",
      "acl_denied",
      "forbidden",
    ]);
    // Same audit shape as read_notes' own denial row (only the tool name differs).
    for (const row of denialRows) {
      expect({ ...row, tool_name: "read_notes" }).toEqual({
        ...readNotesRow,
        error_code: row.error_code,
      });
    }
    expect(rows.filter((e) => e.status === "ok")).toHaveLength(1);
    expect(emitted.filter((e) => e.type === "tc.acl.denied")).toHaveLength(3);
    const text = await metrics.metrics();
    expect(text).toMatch(
      /obsidian_tc_acl_denied_total\{vault="test",scope_class="read",reason="acl_denied"\} 3/,
    ); // 1 from the read_notes baseline + 2 here
    expect(text).toMatch(
      /obsidian_tc_acl_denied_total\{vault="test",scope_class="read",reason="forbidden"\} 1/,
    );
  });

  it("a batch with no denials emits no denial records", async () => {
    const { v, emitted } = vault(FILES);
    const r = await v.call("read_resources", { uris: [uri("pub/a.md"), uri("pub/none.md")] });
    expect(r.ok).toBe(true);
    expect(v.events().filter((e) => e.status === "error")).toEqual([]);
    expect(emitted.filter((e) => e.type === "tc.acl.denied")).toEqual([]);
  });
});

describe("read_resources: denied and missing do not reveal a hidden note", () => {
  const item = async (v: TestVault, u: string) => {
    const r = await v.call("read_resources", { uris: [u] });
    if (!r.ok) throw new Error("call failed");
    return (r.data as { results: { ok: boolean; error: unknown }[] }).results[0];
  };

  it("a hidden note that exists and one that does not are byte-identical to the caller", async () => {
    const { v } = vault(FILES);
    const exists = await item(v, uri("secret/b.md"));
    const absent = await item(v, uri("secret/none.md"));
    expect(exists?.ok).toBe(false);
    expect({ ...(exists as object), uri: "" }).toEqual({ ...(absent as object), uri: "" });
  });

  it("a folder and a missing note under an allowed path answer the same (no type oracle)", async () => {
    const { v } = vault(FILES);
    const folder = (await item(v, uri("pub/sub"))) as { error: { code: string; message: string } };
    const missing = (await item(v, uri("pub/none"))) as {
      error: { code: string; message: string };
    };
    expect(missing.error.code).toBe("note_not_found");
    expect(folder.error).toEqual(missing.error);
  });

  it("the per-item error carries no filesystem path or ACL detail", async () => {
    const { v } = vault(FILES);
    const r = await item(v, uri("secret/b.md"));
    const json = JSON.stringify(r);
    expect(json).not.toContain(v.root);
    expect(json).not.toContain("details");
  });
});

describe("read_resources: gates that are not keyed on pathAcl still apply", () => {
  it("the rate limiter throttles it (one read token per call, like read_notes)", async () => {
    const limiter = new RateLimiter({ read: { perMinute: 1, burst: 1 } } as never);
    const { v } = vault(FILES, { registryOpts: { rateLimiter: limiter } });
    const now = () => 0;
    const first = await v.call("read_resources", { uris: [uri("pub/a.md")] }, { now });
    expect(first.ok).toBe(true);
    const second = await v.call("read_resources", { uris: [uri("pub/a.md")] }, { now });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("throttled");
  });

  it("a disabled read_resources is indistinguishable from an unregistered tool", async () => {
    const { v } = vault(FILES, {
      registryOpts: { toolVisibility: { ...ALLOW_ALL, disabled: ["read_resources"] } },
    });
    const r = await v.call("read_resources", { uris: [uri("pub/a.md")] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("not_found");
  });

  it("a read-only ACL does not block a read (and does not need a write scope)", async () => {
    const { v } = vault(FILES, { acl: { readOnly: true, readPaths: ["pub/**"] } });
    const r = await v.call("read_resources", { uris: [uri("pub/a.md")] });
    expect(r.ok).toBe(true);
  });

  it("the read:notes scope is still required", async () => {
    const { v } = vault(FILES);
    const r = await v.call(
      "read_resources",
      { uris: [uri("pub/a.md")] },
      { grantedScopes: new Set(["write:notes"]) },
    );
    expect(r.ok).toBe(false);
  });

  it("an unauthenticated caller is refused", async () => {
    const { v } = vault(FILES);
    const r = await v.call("read_resources", { uris: [uri("pub/a.md")] }, { authenticated: false });
    expect(r.ok).toBe(false);
  });
});
