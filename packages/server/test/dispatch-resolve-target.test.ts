// `resolveTarget` (registry/types.ts): a tool whose target is chosen by LIVE external state — the
// note open in Obsidian — rather than by an argument. The hazard it exists to close: with the
// target absent from the arguments, everything dispatch keys on the arguments (the HITL args_hash,
// the idempotency claim, the folder ACL, the replay_drift fingerprint) would be blind to WHICH note
// the call lands on, so a confirmation raised for note A could be redeemed after focus moved to
// note B. Every case here is that hazard or a gate ordering it depends on.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import type { RegistryOptions } from "../src/mcp/registry/types";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

function fixture(opts: {
  active: () => string;
  destructive?: boolean;
  ownAcl?: FolderAcl;
  onEpisode?: RegistryOptions["onEpisode"];
}) {
  const root = mkdtempSync(join(tmpdir(), "obtc-resolve-target-"));
  dirs.push(root);
  mkdirSync(join(root, "private"), { recursive: true });
  for (const f of ["a.md", "b.md", "private/secret.md"]) writeFileSync(join(root, f), `# ${f}`);
  const db = openMemoryDb();
  provisionCacheDb(db);
  const resolve = vi.fn(async () => ({ path: opts.active() }));
  const handler = vi.fn((input: { path: string }) => ({ hit: input.path }));
  const tool: ToolDefinition = {
    name: "touch_active",
    description: "test tool whose target is resolved at dispatch",
    inputSchema: z.object({ vault: z.string(), idempotency_key: z.string().optional() }).strict(),
    requiredScopes: ["write:notes"],
    ...(opts.destructive ? { destructive: true } : {}),
    vaultArg: "vault",
    acceptsIdempotencyKey: true,
    resolveTarget: resolve,
    pathAcl: (input) => [{ op: "write", path: (input as { path: string }).path }],
    handler: handler as never,
  };
  const reg = new ToolRegistry({
    verifyElicit: elicitVerifier,
    rootResolver: () => root,
    ...(opts.onEpisode ? { onEpisode: opts.onEpisode } : {}),
    ...(opts.ownAcl ? { aclResolver: () => opts.ownAcl } : {}),
  });
  reg.register(tool);
  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: "t",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db,
    ...over,
  });
  return { reg, ctx, db, resolve, handler };
}

describe("resolveTarget stage", () => {
  it("merges the resolved target into the input the handler and pathAcl see", async () => {
    const f = fixture({ active: () => "a.md" });
    const r = await f.reg.dispatch("touch_active", { vault: "v1" }, f.ctx());
    expect(r.ok).toBe(true);
    expect(f.handler).toHaveBeenCalledTimes(1);
    expect(f.handler.mock.calls[0]?.[0]).toMatchObject({ vault: "v1", path: "a.md" });
  });

  it("records the resolved target as the call's arguments in the episode/audit trail", async () => {
    const episodes: Array<{ args: unknown; argsHash: string }> = [];
    const f = fixture({ active: () => "b.md", onEpisode: (e) => episodes.push(e) });
    await f.reg.dispatch("touch_active", { vault: "v1" }, f.ctx());
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.args).toEqual({ vault: "v1", path: "b.md" });
  });

  it("refuses a resolver that returns a field the input schema already owns", async () => {
    const f = fixture({ active: () => "a.md" });
    f.resolve.mockResolvedValueOnce({ vault: "other", path: "a.md" } as never);
    const r = await f.reg.dispatch("touch_active", { vault: "v1" }, f.ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("internal");
    expect(f.handler).not.toHaveBeenCalled();
  });

  it("enforces the folder ACL on the RESOLVED path, before the handler, without echoing it", async () => {
    const acl = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      writePaths: ["a.md"],
    });
    const f = fixture({ active: () => "private/secret.md", ownAcl: acl });
    const r = await f.reg.dispatch("touch_active", { vault: "v1" }, f.ctx());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("acl_denied");
    // The path was discovered server-side, not supplied by the caller: a caller the ACL keeps out of
    // `private/` must not learn its active note lives there through the denial.
    expect(JSON.stringify(r.error)).not.toContain("private/secret.md");
    expect(f.handler).not.toHaveBeenCalled();
  });

  it("does not resolve for a caller who fails an earlier gate (scope, read-only)", async () => {
    const f = fixture({ active: () => "a.md" });
    const noScope = await f.reg.dispatch(
      "touch_active",
      { vault: "v1" },
      f.ctx({ grantedScopes: new Set(["read:notes"]) }),
    );
    expect(noScope.ok).toBe(false);
    const ro = fixture({
      active: () => "a.md",
      ownAcl: new FolderAcl({ readOnly: true, defaultScopes: [], rules: [] }),
    });
    const denied = await ro.reg.dispatch("touch_active", { vault: "v1" }, ro.ctx());
    expect(denied.ok).toBe(false);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(ro.resolve).not.toHaveBeenCalled();
  });

  it("surfaces a typed resolver failure and never runs the handler", async () => {
    const f = fixture({ active: () => "a.md" });
    f.resolve.mockRejectedValueOnce(
      new ObsidianTcError("note_not_found", "no active file", { hint: "open a note" }),
    );
    const r = await f.reg.dispatch("touch_active", { vault: "v1" }, f.ctx());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("note_not_found");
    expect(r.error.details).toMatchObject({ hint: "open a note" });
    expect(f.handler).not.toHaveBeenCalled();
  });

  it("binds the resolved target into the idempotency claim", async () => {
    let active = "a.md";
    const f = fixture({ active: () => active });
    const call = () =>
      f.reg.dispatch("touch_active", { vault: "v1", idempotency_key: "k1" }, f.ctx());
    expect((await call()).ok).toBe(true);
    // Same key, same arguments, but focus moved: this is a different call, not a replay of the first.
    active = "b.md";
    const second = await call();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("idempotency_key_mismatch");
    // Back on the original target the key replays the cached result instead of re-running.
    active = "a.md";
    const third = await call();
    expect(third.ok).toBe(true);
    expect(f.handler).toHaveBeenCalledTimes(1);
  });

  it("HITL: a confirmation raised for note A is not redeemable once the target is note B", async () => {
    let active = "a.md";
    const f = fixture({ active: () => active, destructive: true });
    const first = await f.reg.dispatch("touch_active", { vault: "v1" }, f.ctx());
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.code).toBe("elicit_required");
    const hashA = (first.error.details as { args_hash: string }).args_hash;
    const token = () =>
      issueElicitToken(f.db, {
        vaultId: "v1",
        toolName: "touch_active",
        argsHash: hashA,
        caller: "t",
      });

    // Focus moves to B: the SAME token, the SAME arguments — must not clear the gate.
    active = "b.md";
    const onB = await f.reg.dispatch(
      "touch_active",
      { vault: "v1" },
      f.ctx({ elicitToken: token() }),
    );
    expect(onB.ok).toBe(false);
    if (!onB.ok) {
      expect(onB.error.code).toBe("elicit_required");
      expect((onB.error.details as { args_hash: string }).args_hash).not.toBe(hashA);
    }
    expect(f.handler).not.toHaveBeenCalled();

    // Focus back on A: the confirmation the human gave for A still works for A.
    active = "a.md";
    const onA = await f.reg.dispatch(
      "touch_active",
      { vault: "v1" },
      f.ctx({ elicitToken: token() }),
    );
    expect(onA.ok).toBe(true);
    expect(f.handler).toHaveBeenCalledTimes(1);
    expect(f.handler.mock.calls[0]?.[0]).toMatchObject({ path: "a.md" });
  });
});
