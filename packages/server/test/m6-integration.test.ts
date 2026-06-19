// M6 live-vault integration (THE-182): the M1 + full M6 surface registered on ONE
// shared ToolRegistry via registerM6Tools — the exact coexistence cli.ts assembles —
// driven end-to-end through dispatch over a real temp vault. Asserts the bulk
// per-item report, the bulk HITL floor, read-only ACL denial, the token-bucket
// throttle, a generated URI, the admin tools, and event_log audit rows. No live
// Obsidian, no network.
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../src/throttle";
import { registerM6Tools } from "../src/tools/m6";
import { type M6Vault, makeM6Vault } from "./m6-helpers";

function data<T = Record<string, unknown>>(r: ToolResult): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
}

let v: M6Vault | undefined;
afterEach(() => v?.cleanup());

describe("M6 live-vault integration", () => {
  it("runs the full bulk/URI/admin surface alongside M1 on one registry", async () => {
    v = makeM6Vault({
      files: { "B.md": "links to [[A]]" },
      register: (r, d) => registerM6Tools(r, d),
    });

    // ── Bulk create (HITL-confirmed) with a per-item report ──────────────────
    const created = data<{ processed: number; succeeded: number; results: { ok: boolean }[] }>(
      await v.callConfirmed("bulk_create_notes", {
        vault: "test",
        items: [
          { path: "A.md", content: "# A", frontmatter: { status: "draft" } },
          { path: "notes/n1.md", content: "one" },
        ],
      }),
    );
    expect(created).toMatchObject({ processed: 2, succeeded: 2 });
    // Read a created note back through the M1 tool — proves the shared registry.
    const a = data<{ frontmatter: Record<string, unknown>; body: string }>(
      await v.call("read_note", { vault: "test", path: "A.md" }),
    );
    expect(a.frontmatter.status).toBe("draft");

    // ── Bulk set property across the batch ───────────────────────────────────
    const set = data<{ succeeded: number }>(
      await v.callConfirmed("bulk_set_property", {
        vault: "test",
        paths: ["A.md", "notes/n1.md"],
        key: "reviewed",
        value: true,
      }),
    );
    expect(set.succeeded).toBe(2);

    // ── Bulk move (real) rewrites the backlink in B.md ───────────────────────
    const moved = data<{ total_backlinks_updated: number; results: { ok: boolean }[] }>(
      await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        moves: [{ from: "A.md", to: "Renamed.md" }],
      }),
    );
    expect(moved.results[0]?.ok).toBe(true);
    expect(moved.total_backlinks_updated).toBe(1);
    expect(v.read("B.md")).toBe("links to [[Renamed]]");
    expect(v.exists("Renamed.md")).toBe(true);

    // ── URI generation through dispatch (pure, no scope) ─────────────────────
    const uri = data<{ uri: string }>(
      await v.call("generate_uri", {
        vault: "My Vault",
        action: "open",
        params: { file: "Renamed.md" },
      }),
    );
    expect(uri.uri).toBe("obsidian://open?vault=My%20Vault&file=Renamed.md");

    // ── Admin: get_server_config + get_metrics ───────────────────────────────
    const cfg = data<{ limits: Record<string, number> }>(await v.call("get_server_config", {}));
    expect(cfg.limits.max_operations_per_minute).toBe(10);

    const metrics = data<{
      metrics: { name: string; labels: Record<string, string>; value: number }[];
    }>(await v.call("get_metrics", { vault: "test" }));
    const createCounter = metrics.metrics.find(
      (m) => m.name === "obsidian_tc_tool_calls_total" && m.labels.tool === "bulk_create_notes",
    );
    expect((createCounter?.value ?? 0) >= 1).toBe(true);

    // ── Audit: every dispatched M6 tool wrote an ok event_log row ────────────
    const ev = v.events();
    for (const t of [
      "bulk_create_notes",
      "bulk_set_property",
      "bulk_move_notes",
      "generate_uri",
      "get_server_config",
      "get_metrics",
    ]) {
      expect(ev.some((e) => e.tool_name === t && e.status === "ok")).toBe(true);
    }
  });

  it("enforces the bulk HITL floor (no token -> elicit_required) and read-only denial", async () => {
    v = makeM6Vault({ register: (r, d) => registerM6Tools(r, d) });
    const noToken = await v.call("bulk_create_notes", {
      vault: "test",
      items: [{ path: "x.md", content: "x" }],
    });
    expect(noToken.ok).toBe(false);
    if (!noToken.ok) expect(noToken.error.code).toBe("elicit_required");

    const ro = makeM6Vault({ acl: { readOnly: true }, register: (r, d) => registerM6Tools(r, d) });
    try {
      const denied = await ro.callConfirmed("bulk_set_property", {
        vault: "test",
        paths: ["a.md"],
        key: "k",
        value: 1,
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("forbidden");
    } finally {
      ro.cleanup();
    }
  });

  it("throttles bulk ops at the bulk tier (3 burst, then throttled)", async () => {
    v = makeM6Vault({
      files: { "a.md": "A" },
      rateLimiter: new RateLimiter(),
      now: () => 0,
      register: (r, d) => registerM6Tools(r, d),
    });
    const input = { vault: "test", paths: ["a.md"], key: "k", value: 1 };
    for (let i = 0; i < 3; i++)
      expect((await v.callConfirmed("bulk_set_property", input)).ok).toBe(true);
    const throttled = await v.callConfirmed("bulk_set_property", input);
    expect(throttled.ok).toBe(false);
    if (!throttled.ok) expect(throttled.error.code).toBe("throttled");
  });
});
