// get_provenance and the read ACL. Provenance names paths, principals and sessions, so the tool is
// only as private as its path filter. Red cases first: an unreadable path must be indistinguishable
// from a path that was never written, a record naming several paths must not reveal the ones the
// caller cannot read, and one vault's records and ACL must never serve another vault.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { createPagingDeps } from "../src/mcp/byte-page";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { registrySignerSource } from "../src/provenance/signer";
import { appendProvenance } from "../src/provenance/store";
import type { PathEntry } from "../src/provenance/types";
import { registerM1Tools } from "../src/tools/m1";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { CLOCK0, provenanceFixture } from "./provenance-helpers";
import { h, moved, queryFixture } from "./provenance-query-helpers";
import { rmTemp } from "./tmp";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

type Fx = Awaited<ReturnType<typeof queryFixture>>;
async function make(...a: Parameters<typeof queryFixture>): Promise<Fx> {
  const f = await queryFixture(...a);
  cleanups.push(f.cleanup);
  return f;
}

/** Error body with the queried path blanked, so two denials compare on SHAPE, not on the path. */
function shape(r: ToolResult, path: string): string {
  expect(r.ok).toBe(false);
  if (r.ok) return "";
  const { code, message, details } = r.error as unknown as Record<string, unknown>;
  return JSON.stringify({ code, message, details }).split(path).join("<path>");
}

const READ_PUB = { readPaths: ["pub/**"] };

describe("RED: an unreadable path answers exactly like a path that was never written", () => {
  it("folder whitelist: written-but-unreadable, never-written-unreadable and never-written-readable are one shape", async () => {
    const f = await make({ acl: READ_PUB });
    f.add({ paths: ["secret/x.md"], verified: { principal: "alice", session_id: "s-1" } });
    f.add({ paths: ["pub/known.md"] });
    const hidden = await f.get({ path: "secret/x.md" });
    const hiddenNever = await f.get({ path: "secret/never.md" });
    const visibleNever = await f.get({ path: "pub/never.md" });
    expect(shape(hidden, "secret/x.md")).toBe(shape(visibleNever, "pub/never.md"));
    expect(shape(hiddenNever, "secret/never.md")).toBe(shape(visibleNever, "pub/never.md"));
    expect((hidden as { error: { code: string } }).error.code).toBe("not_found");
    // Sanity: the readable path with records still works, so the above is not a blanket denial.
    expect((await f.get({ path: "pub/known.md" })).ok).toBe(true);
  });

  it("an unreadable path with since/until or a cursor is an empty page, the same as a never-written one", async () => {
    const f = await make({ acl: READ_PUB });
    f.add({ paths: ["secret/x.md"] });
    for (const extra of [{ since: 1 }, { until: CLOCK0 + 99 }, { cursor: "5" }]) {
      const a = await f.get({ path: "secret/x.md", ...extra });
      const b = await f.get({ path: "pub/never.md", ...extra });
      expect(a.ok && b.ok).toBe(true);
      expect(a.ok && a.data).toMatchObject({ records: [], next_cursor: null, previous_paths: [] });
      expect(
        JSON.stringify(a.ok && a.data)
          .split("secret/x.md")
          .join("pub/never.md"),
      ).toBe(JSON.stringify(b.ok && b.data));
    }
  });

  it("the hard default-deny roots are not_found too", async () => {
    const f = await make({ acl: { readPaths: ["**"] } });
    f.add({ paths: [".obsidian/app.json"] });
    const r = await f.get({ path: ".obsidian/app.json" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("not_found");
  });

  it("rule-scopes: a path whose rule needs a scope the caller lacks is hidden, and shown to one who holds it", async () => {
    const f = await make({ acl: { rules: [{ glob: "finance/**", scopes: ["read:finance"] }] } });
    f.add({ paths: ["finance/q1.md"] });
    const without = await f.get(
      { path: "finance/q1.md" },
      { grantedScopes: new Set(["read:notes", "read:provenance"]) },
    );
    expect(without.ok).toBe(false);
    if (!without.ok) expect(without.error.code).toBe("not_found");
    const withScope = await f.get(
      { path: "finance/q1.md" },
      { grantedScopes: new Set(["read:notes", "read:provenance", "read:finance"]) },
    );
    expect(withScope.ok).toBe(true);
  });

  it("no part of the denial mentions that records exist", async () => {
    const f = await make({ acl: READ_PUB });
    f.add({
      paths: ["secret/x.md"],
      verified: { principal: "alice-the-admin", session_id: "sess-777" },
    });
    const text = JSON.stringify(await f.get({ path: "secret/x.md" }));
    expect(text).not.toContain("alice-the-admin");
    expect(text).not.toContain("sess-777");
    expect(text).not.toContain("acl_denied");
  });
});

describe("RED: a record naming several paths never reveals one the caller cannot read", () => {
  it("move from an unreadable path: the destination's record lists only readable paths", async () => {
    const f = await make({ acl: READ_PUB });
    f.add({ paths: ["secret/plans.md"] }); // 1
    f.add({ paths: ["secret/plans.md"] }); // 2
    f.add({ tool: "move_note", paths: moved("secret/plans.md", "pub/plans.md") }); // 3
    f.add({ paths: ["pub/plans.md"] }); // 4
    for (const fmt of ["detailed", "concise"]) {
      for (const verify of [false, true]) {
        const r = await f.get({
          path: "pub/plans.md",
          response_format: fmt,
          include_verification: verify,
        });
        expect(r.ok).toBe(true);
        const text = JSON.stringify(r.ok && r.data);
        expect(text).not.toContain("secret");
        if (r.ok) {
          const d = r.data as { records: Array<{ seq: number }>; previous_paths: string[] };
          // The hidden source ends the walk: its own records are not part of this history.
          expect(d.records.map((x) => x.seq)).toEqual([4, 3]);
          expect(d.previous_paths).toEqual([]);
        }
      }
    }
  });

  it("the move record keeps the readable end, with nothing standing in for the hidden one", async () => {
    const f = await make({ acl: READ_PUB });
    f.add({ tool: "move_note", paths: moved("secret/plans.md", "pub/plans.md") });
    const r = await f.get({ path: "pub/plans.md" });
    const rec = (r.ok && (r.data as { records: Array<Record<string, unknown>> }).records[0]) || {};
    expect(rec.paths).toEqual([{ path: "pub/plans.md", before: "absent", after: h("cc") }]);
    expect(rec).not.toHaveProperty("paths_truncated");
  });

  it("a bulk record spanning readable and unreadable paths shows only the readable ones", async () => {
    const f = await make({ acl: READ_PUB });
    f.add({
      tool: "bulk_move_notes",
      paths: [
        ...moved("secret/a.md", "pub/a.md", h("11")),
        ...moved("pub/b.md", "private-archive/b.md", h("22")),
        ...moved("pub/c.md", "pub/d.md", h("33")),
      ],
    });
    const r = await f.get({ path: "pub/d.md" });
    const paths = (
      (r.ok &&
        (r.data as { records: Array<{ paths: Array<{ path: string }> }> }).records[0]?.paths) ||
      []
    ).map((p) => p.path);
    expect(paths).toEqual(["pub/a.md", "pub/b.md", "pub/c.md", "pub/d.md"]);
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(JSON.stringify(r)).not.toContain("private-archive");
  });

  it("a copy whose source is unreadable lists only the destination", async () => {
    const f = await make({ acl: READ_PUB });
    f.add({
      tool: "copy_note",
      paths: [
        { path: "secret/src.md", before: h("cc"), after: h("cc") },
        { path: "pub/copy.md", before: "absent", after: h("cc") },
      ],
    });
    const r = await f.get({ path: "pub/copy.md" });
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(r.ok && (r.data as { records: unknown[] }).records).toHaveLength(1);
  });

  it("a hidden path with a stored spelling that normalizes into the denied folder is still hidden", async () => {
    const f = await make({ acl: READ_PUB });
    f.add({
      tool: "bulk_move_notes",
      paths: [...moved("./secret//x.md", "pub/y.md"), ...moved("pub/z.md", "pub\\w.md")],
    });
    const r = await f.get({ path: "pub/y.md" });
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("an unreadable previous path of a chain stops the walk even when a later hop would be readable", async () => {
    const f = await make({ acl: READ_PUB });
    f.add({ paths: ["pub/a.md"] }); // 1
    f.add({ tool: "move_note", paths: moved("pub/a.md", "secret/b.md") }); // 2
    f.add({ tool: "move_note", paths: moved("secret/b.md", "pub/c.md") }); // 3
    const r = await f.get({ path: "pub/c.md" });
    const d = (r.ok &&
      (r.data as { records: Array<{ seq: number }>; previous_paths: string[] })) || {
      records: [],
      previous_paths: ["?"],
    };
    expect(d.records.map((x) => x.seq)).toEqual([3]);
    expect(d.previous_paths).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});

describe("cross-vault isolation", () => {
  async function twoVaults() {
    const fx = await provenanceFixture();
    const alpha = mkdtempSync(join(tmpdir(), "obtc-prov-alpha-"));
    const beta = mkdtempSync(join(tmpdir(), "obtc-prov-beta-"));
    cleanups.push(() => {
      rmTemp(alpha);
      rmTemp(beta);
      rmTemp(fx.dir);
    });
    const db = openMemoryDb();
    provisionCacheDb(db);
    const open = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
    const betaAcl = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      readPaths: ["public/**"],
    });
    const acls = new Map([
      ["alpha", open],
      ["beta", betaAcl],
    ]);
    const vaultRegistry = new VaultRegistry([
      { id: "alpha", path: alpha },
      { id: "beta", path: beta },
    ]);
    const registry = new ToolRegistry({ aclResolver: (id: string) => acls.get(id) ?? open });
    registerM1Tools(registry, {
      vaultRegistry,
      version: "test",
      startedAt: 0,
      embeddings: { provider: "ollama", model: "nomic-embed-text" },
      provenanceKeys: () => fx.resolveKey(),
      paging: createPagingDeps({ secret: "s", budgetBytes: () => registry.maxResponseBytes }),
    });
    let n = 0;
    const add = (vault: string, tool: string, paths: Array<string | PathEntry>) => {
      n++;
      appendProvenance(
        db,
        {
          vaultId: vault,
          ts: CLOCK0 + n,
          tool,
          outcome: "ok",
          paths: paths.map((p) =>
            typeof p === "string" ? { path: p, before: h("aa"), after: h(`b${n}`) } : p,
          ),
          pathsOmitted: 0,
          verified: { host: "h", server_version: "1", principal: `p-${vault}` },
          unauthenticated: {},
          self_reported: {},
        },
        registrySignerSource(fx.registry)(),
      );
    };
    const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
      caller: "t",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "alpha",
      db,
      acl: open,
      ...over,
    });
    const call = (input: Record<string, unknown>, over: Partial<CallerContext> = {}) =>
      registry.dispatch("get_provenance", input, ctx(over));
    return { registry, add, call, ctx, open, betaAcl };
  }

  it("the same path in two vaults returns each vault's own records only", async () => {
    const v = await twoVaults();
    v.add("alpha", "write_note", ["public/n.md"]);
    v.add("beta", "patch_note", ["public/n.md"]);
    v.add("alpha", "append_note", ["public/n.md"]);
    const a = await v.call({ vault: "alpha", path: "public/n.md" });
    const b = await v.call({ vault: "beta", path: "public/n.md" });
    expect(
      a.ok && (a.data as { records: Array<{ tool: string }> }).records.map((r) => r.tool),
    ).toEqual(["append_note", "write_note"]);
    expect(
      b.ok && (b.data as { records: Array<{ tool: string }> }).records.map((r) => r.tool),
    ).toEqual(["patch_note"]);
    expect(JSON.stringify(a)).not.toContain("p-beta");
    expect(JSON.stringify(b)).not.toContain("p-alpha");
  });

  it("a move lineage never crosses into another vault's chain", async () => {
    const v = await twoVaults();
    v.add("alpha", "write_note", ["public/old.md"]);
    v.add("alpha", "move_note", moved("public/old.md", "public/new.md"));
    v.add("beta", "write_note", ["public/new.md"]);
    const b = await v.call({ vault: "beta", path: "public/new.md" });
    expect(b.ok && (b.data as { records: unknown[] }).records).toHaveLength(1);
    expect(b.ok && (b.data as { previous_paths: string[] }).previous_paths).toEqual([]);
  });

  it("a caller bound to one vault cannot query another", async () => {
    const v = await twoVaults();
    v.add("beta", "write_note", ["public/n.md"]);
    const r = await v.call(
      { vault: "beta", path: "public/n.md" },
      { vaultBound: true, vaultId: "alpha" },
    );
    expect(r.ok).toBe(false);
  });

  it("RED: vault B's own ACL governs vault B, whatever the caller's default ACL allows", async () => {
    const v = await twoVaults();
    v.add("alpha", "write_note", ["private/x.md"]);
    v.add("beta", "write_note", ["private/x.md"]);
    v.add("beta", "bulk_move_notes", moved("private/y.md", "public/y.md", h("44")));
    // Through dispatch (which swaps in the vault's ACL) ...
    const viaDispatch = await v.call({ vault: "beta", path: "private/x.md" });
    const never = await v.call({ vault: "beta", path: "private/never.md" });
    expect(shape(viaDispatch, "private/x.md")).toBe(shape(never, "private/never.md"));
    // ... and the same call on vault A, whose ACL allows it, still works.
    expect((await v.call({ vault: "alpha", path: "private/x.md" })).ok).toBe(true);
    // The handler itself must not lean on the swap: hand it the caller's PERMISSIVE default ACL.
    const def = v.registry.list().find((t) => t.name === "get_provenance");
    const direct = async (path: string) => {
      try {
        return {
          ok: true as const,
          data: await def?.handler(
            { vault: "beta", path, limit: 50, include_verification: false },
            v.ctx({ acl: v.open }),
          ),
        };
      } catch (e) {
        return { ok: false as const, error: e as { code?: string } };
      }
    };
    const hiddenDirect = await direct("private/x.md");
    expect(hiddenDirect.ok).toBe(false);
    expect(hiddenDirect.ok === false && hiddenDirect.error.code).toBe("not_found");
    // A multi-path record in B never reveals `private/...`.
    const y = await direct("public/y.md");
    expect(JSON.stringify(y)).not.toContain("private/");
  });
});
