// M6 Domain 25 bulk tools through real dispatch (THE-182). Proves the bulk HITL
// floor (elicit_required without a token), read-only ACL denial, the token-bucket
// throttle, the per-item partial-failure report, and the bulk_move dry_run/real +
// all-or-nothing backlink rewrite. The RateLimiter clock is pinned via ctx.now so
// the throttle assertions are deterministic.
import type { ToolResult } from "@obsidian-tc/shared";
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../src/throttle";
import { buildBulkTools } from "../src/tools/m6/bulk-tools";
import { type M6Vault, makeM6Vault } from "./m6-helpers";

const register = (
  r: import("../src/mcp/registry").ToolRegistry,
  d: import("../src/tools/m6/shared").M6Deps,
) => {
  for (const t of buildBulkTools(d)) r.register(t);
};

function data<T = Record<string, unknown>>(r: ToolResult): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
}
function errOf(r: ToolResult): { code: string; details?: Record<string, unknown> } {
  if (r.ok) throw new Error("expected error, got ok");
  return r.error;
}

let v: M6Vault | undefined;
afterEach(() => v?.cleanup());

describe("bulk_create_notes", () => {
  it("creates a batch and reports per-item results (HITL-confirmed)", async () => {
    v = makeM6Vault({ register });
    const out = data<{
      processed: number;
      succeeded: number;
      failed: number;
      results: { ok: boolean; mode_used?: string }[];
    }>(
      await v.callConfirmed("bulk_create_notes", {
        vault: "test",
        items: [
          { path: "a.md", content: "A" },
          { path: "b.md", content: "B", frontmatter: { tag: "x" } },
        ],
      }),
    );
    expect(out).toMatchObject({ processed: 2, succeeded: 2, failed: 0 });
    expect(out.results[0]?.mode_used).toBe("create");
    expect(v.read("a.md")).toBe("A");
    expect(v.read("b.md")).toContain("tag: x");
  });

  it("is best-effort: a create-conflict fails just that item", async () => {
    v = makeM6Vault({ files: { "b.md": "existing" }, register });
    const out = data<{
      succeeded: number;
      failed: number;
      results: { ok: boolean; error?: { code: string } }[];
    }>(
      await v.callConfirmed("bulk_create_notes", {
        vault: "test",
        items: [
          { path: "a.md", content: "A" },
          { path: "b.md", content: "B" }, // create on existing -> note_exists
          { path: "c.md", content: "C" },
        ],
      }),
    );
    expect(out.succeeded).toBe(2);
    expect(out.failed).toBe(1);
    expect(out.results[1]).toMatchObject({ ok: false });
    expect(out.results[1]?.error?.code).toBe("note_exists");
  });

  it("stops at the first error when stop_on_first_error is set (sequential)", async () => {
    v = makeM6Vault({ files: { "b.md": "x" }, register });
    const out = data<{ processed: number; succeeded: number; failed: number }>(
      await v.callConfirmed("bulk_create_notes", {
        vault: "test",
        max_concurrent: 1,
        stop_on_first_error: true,
        items: [
          { path: "a.md", content: "A" },
          { path: "b.md", content: "B" }, // fails
          { path: "c.md", content: "C" }, // never attempted
        ],
      }),
    );
    expect(out.processed).toBe(2);
    expect(out.failed).toBe(1);
    expect(v.exists("c.md")).toBe(false);
  });

  it("requires a HITL elicit token (bulk floor) — no token -> elicit_required", async () => {
    v = makeM6Vault({ register });
    const r = await v.call("bulk_create_notes", {
      vault: "test",
      items: [{ path: "a.md", content: "A" }],
    });
    expect(errOf(r).code).toBe("elicit_required");
    expect(v.exists("a.md")).toBe(false);
  });

  it("is denied under a read-only ACL (bulk is mutating)", async () => {
    v = makeM6Vault({ acl: { readOnly: true }, register });
    const r = await v.callConfirmed("bulk_create_notes", {
      vault: "test",
      items: [{ path: "a.md", content: "A" }],
    });
    expect(errOf(r).code).toBe("forbidden");
    expect(v.exists("a.md")).toBe(false);
  });
});

describe("bulk_set_property", () => {
  it("sets a property across notes and reports prev_value", async () => {
    v = makeM6Vault({
      files: { "a.md": "---\nstatus: draft\n---\nA", "b.md": "B" },
      register,
    });
    const out = data<{ succeeded: number; results: { path: string; prev_value: unknown }[] }>(
      await v.callConfirmed("bulk_set_property", {
        vault: "test",
        paths: ["a.md", "b.md"],
        key: "status",
        value: "published",
      }),
    );
    expect(out.succeeded).toBe(2);
    expect(out.results.find((r) => r.path === "a.md")?.prev_value).toBe("draft");
    expect(out.results.find((r) => r.path === "b.md")?.prev_value).toBe(null);
    expect(v.read("a.md")).toContain("status: published");
    expect(v.read("b.md")).toContain("status: published");
  });

  it("reports note_not_found for a missing path (best-effort)", async () => {
    v = makeM6Vault({ files: { "a.md": "A" }, register });
    const out = data<{ failed: number; results: { ok: boolean; error?: { code: string } }[] }>(
      await v.callConfirmed("bulk_set_property", {
        vault: "test",
        paths: ["a.md", "missing.md"],
        key: "k",
        value: 1,
      }),
    );
    expect(out.failed).toBe(1);
    expect(out.results.find((r) => !r.ok)?.error?.code).toBe("note_not_found");
  });
});

describe("bulk throttle (token bucket)", () => {
  it("enforces the bulk tier: burst of 3 then throttled with G2.4 detail", async () => {
    v = makeM6Vault({
      files: { "a.md": "A" },
      rateLimiter: new RateLimiter(),
      now: () => 0, // pin the clock so refill never happens mid-test
      register,
    });
    const input = { vault: "test", paths: ["a.md"], key: "k", value: 1 };
    for (let i = 0; i < 3; i++) {
      expect((await v.callConfirmed("bulk_set_property", input)).ok).toBe(true);
    }
    const r = await v.callConfirmed("bulk_set_property", input);
    const e = errOf(r);
    expect(e.code).toBe("throttled");
    expect(e.details).toMatchObject({
      scope_class: "bulk",
      retry_after_seconds: 6,
      current_rate: 10,
    });
  });
});

describe("bulk_move_notes", () => {
  it("dry_run (default) previews backlink rewrites without touching disk", async () => {
    v = makeM6Vault({ files: { "A.md": "# A", "B.md": "see [[A]]" }, register });
    const out = data<{
      dry_run: boolean;
      total_backlinks_updated: number;
      results: { ok: boolean; backlinks_updated?: number }[];
    }>(
      await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        moves: [{ from: "A.md", to: "C.md" }],
      }),
    );
    expect(out.dry_run).toBe(true);
    expect(out.total_backlinks_updated).toBe(1); // [[A]] -> [[C]] would change
    expect(out.results[0]?.backlinks_updated).toBe(1);
    expect(v.exists("A.md")).toBe(true); // not moved
    expect(v.exists("C.md")).toBe(false);
    expect(v.read("B.md")).toBe("see [[A]]"); // untouched
  });

  it("real move relocates files and rewrites backlinks (all-or-nothing)", async () => {
    v = makeM6Vault({ files: { "A.md": "# A", "B.md": "see [[A]]" }, register });
    const out = data<{
      dry_run: boolean;
      total_backlinks_updated: number;
      results: { ok: boolean }[];
    }>(
      await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        moves: [{ from: "A.md", to: "C.md" }],
      }),
    );
    expect(out.dry_run).toBe(false);
    expect(out.results[0]?.ok).toBe(true);
    expect(out.total_backlinks_updated).toBe(1);
    expect(v.exists("A.md")).toBe(false);
    expect(v.exists("C.md")).toBe(true);
    expect(v.read("B.md")).toBe("see [[C]]"); // rewritten
  });

  it("reports per-move errors (missing source) without aborting valid moves", async () => {
    v = makeM6Vault({ files: { "A.md": "# A" }, register });
    const out = data<{ results: { from: string; ok: boolean; error?: { code: string } }[] }>(
      await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        moves: [
          { from: "A.md", to: "C.md" },
          { from: "ghost.md", to: "x.md" },
        ],
      }),
    );
    expect(out.results.find((r) => r.from === "A.md")?.ok).toBe(true);
    const bad = out.results.find((r) => r.from === "ghost.md");
    expect(bad?.ok).toBe(false);
    expect(bad?.error?.code).toBe("note_not_found");
    expect(v.exists("C.md")).toBe(true);
  });
});
