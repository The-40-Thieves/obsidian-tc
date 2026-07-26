// THE-513 Part 2 — behavioral half of the vaultArg guarantee. vault-arg-coverage.test.ts proves
// every mutating, vault-shaped tool DECLARES vaultArg; this proves the four runDispatch call sites
// (mcp/registry.ts vaultArgOf) actually READ the declared name instead of the literal "vault" —
// a declaration nothing validates is just a comment (THE-513's stated reason for this whole gate).
//
// Each synthetic tool below names its vault field "vault_id" (deliberately NOT "vault") and
// declares `vaultArg: "vault_id"`. Before registry.ts's vaultArgOf fix, all four of these would
// have silently no-op'd (the old code read a field literally called `.vault`, saw undefined, and
// skipped the check entirely) — this is the shape THE-589's generate_uri hit from the opposite
// direction (a `vault_name` colliding with the hardcoded match, forcing a rename instead of a
// declaration). Mirrors cross-vault-binding.test.ts / per-vault-acl.test.ts /
// the-569-vault-kind-gate.test.ts / acl-extraction-coverage.test.ts's own per-mechanism harnesses.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { openMemoryDb } from "./helpers";

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

function ctx(db: Database, over: Partial<CallerContext> = {}): CallerContext {
  return {
    caller: "t",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "a",
    db,
    ...over,
  };
}

describe("THE-513 Part 2: vaultArgOf drives all four dispatch-stage vault reads", () => {
  it("vault-binding guard (THE-267) keys off the declared vaultArg, not a hardcoded 'vault'", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "renamed_vault_echo",
      description: "echoes vault_id",
      vaultArg: "vault_id",
      inputSchema: z.object({ vault_id: z.string().optional() }).strict(),
      requiredScopes: [],
      handler: (i: { vault_id?: string }) => ({ vault_id: i.vault_id ?? null }),
    });
    const denied = await reg.dispatch(
      "renamed_vault_echo",
      { vault_id: "b" },
      ctx(freshDb(), { vaultBound: true }),
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("forbidden");

    const allowed = await reg.dispatch(
      "renamed_vault_echo",
      { vault_id: "a" },
      ctx(freshDb(), { vaultBound: true }),
    );
    expect(allowed.ok).toBe(true);
  });

  it("per-vault ACL swap (THE-295) resolves the ACL for the declared vaultArg's value", async () => {
    const rootAcl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
    const bAcl = new FolderAcl({ readOnly: true, defaultScopes: [], rules: [] });
    const reg = new ToolRegistry({
      aclResolver: (vid) => (vid === "b" ? bAcl : rootAcl),
    });
    reg.register({
      name: "renamed_mutator",
      description: "mutates, gated by acl.readOnly",
      vaultArg: "vault_id",
      inputSchema: z.object({ vault_id: z.string() }).strict(),
      requiredScopes: ["write:notes"],
      handler: () => ({ ok: true }),
    });
    const deniedOnB = await reg.dispatch(
      "renamed_mutator",
      { vault_id: "b" },
      ctx(freshDb(), { acl: rootAcl }),
    );
    expect(deniedOnB.ok).toBe(false);
    if (!deniedOnB.ok) {
      expect(deniedOnB.error.code).toBe("forbidden");
      expect(deniedOnB.error.message).toContain("read-only");
    }
    const allowedOnA = await reg.dispatch(
      "renamed_mutator",
      { vault_id: "a" },
      ctx(freshDb(), { acl: rootAcl }),
    );
    expect(allowedOnA.ok).toBe(true);
  });

  it("reverse vault-kind gate (THE-569) resolves kind for the declared vaultArg's value", async () => {
    const kindByVault: Record<string, "docs" | "system" | "private"> = {
      "docs-vault": "docs",
      a: "private",
    };
    const reg = new ToolRegistry({ vaultKindResolver: (id) => kindByVault[id] });
    reg.register({
      name: "renamed_mutator",
      description: "mutates",
      vaultArg: "vault_id",
      inputSchema: z.object({ vault_id: z.string().optional() }).strict(),
      requiredScopes: ["write:notes"],
      handler: () => ({ ok: true }),
    });
    const denied = await reg.dispatch(
      "renamed_mutator",
      { vault_id: "docs-vault" },
      ctx(freshDb()),
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("forbidden");

    const allowed = await reg.dispatch("renamed_mutator", { vault_id: "a" }, ctx(freshDb()));
    expect(allowed.ok).toBe(true);
  });

  it("central pathAcl enforcement (THE-414) resolves root for the declared vaultArg's value", async () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-vaultarg-central-"));
    try {
      const acl = new FolderAcl({
        readOnly: false,
        defaultScopes: [],
        rules: [],
        writePaths: ["allowed/**"],
      });
      // rootResolver recognizes ONLY "the-real-vault" (the value carried in the call's `vault_id`
      // field) — ctx.vaultId is a DIFFERENT, unmapped id, so a resolver that fell back to
      // ctx.vaultId (the old hardcoded-"vault" behavior, which never finds `.vault` on this input
      // and defaults to ctx.vaultId) resolves no root at all. `if (root)` then SKIPS enforcement
      // entirely — a write outside the whitelist is silently ALLOWED, not denied. That divergence,
      // not a wrong-but-still-enforcing root, is what distinguishes old from new here.
      const reg = new ToolRegistry({
        rootResolver: (vid) => (vid === "the-real-vault" ? root : undefined),
      });
      reg.register({
        name: "renamed_write",
        description: "declares pathAcl(write); handler never calls enforcePathAcl itself",
        vaultArg: "vault_id",
        inputSchema: z.object({ vault_id: z.string(), path: z.string() }).strict(),
        requiredScopes: ["write:notes"],
        pathAcl: (input: { path: string }) => [{ op: "write" as const, path: input.path }],
        handler: () => ({ ok: true }),
      } as any);
      const call = (path: string) =>
        reg.dispatch(
          "renamed_write",
          { vault_id: "the-real-vault", path },
          ctx(
            {
              prepare: () => {
                throw new Error("no db in this unit test");
              },
            } as unknown as Database,
            { acl, vaultId: "unmapped-ctx-vault" },
          ),
        );
      const denied = await call("outside.md");
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
      const allowed = await call("allowed/in.md");
      expect(allowed.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
