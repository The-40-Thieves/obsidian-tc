// Issue #280 follow-up to THE-414: the opt-in ACL audit verifies a tool's declared pathAcl
// extractor actually MIRRORS the vault paths its handler resolves for filesystem ops. These are
// synthetic tools (like the THE-414 central-enforcement test) so no live backend is needed: the
// handler resolves paths via resolveVaultPath, and the audit reports any it touches that the
// central stage never ACL-checked.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import type { Database } from "../src/db/types";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import {
  clearCollectedViolations,
  getCollectedViolations,
  setAclAuditMode,
} from "../src/vault/acl-audit";
import { resolveVaultPath } from "../src/vault/paths";

const stubDb = {
  prepare() {
    throw new Error("no db in this unit test");
  },
} as unknown as Database;

describe("ACL audit: pathAcl mirrors handler fs usage (issue #280)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "obtc-acl-audit-"));
    setAclAuditMode("on");
    clearCollectedViolations();
  });
  afterEach(() => {
    setAclAuditMode("off");
    rmSync(root, { recursive: true, force: true });
  });

  // A synthetic tool whose handler resolves `resolves` for fs ops ("$path" == the input path) and
  // declares a write pathAcl for its input path. rootResolver points the central stage at `root`.
  function call(name: string, resolves: string[]): (path: string) => Promise<{ ok: boolean }> {
    const acl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }); // unrestricted
    const registry = new ToolRegistry({ rootResolver: () => root });
    registry.register({
      name,
      description: "synthetic",
      inputSchema: z.object({ vault: z.string(), path: z.string() }),
      requiredScopes: ["write:notes"],
      pathAcl: (input: { path: string }) => [{ op: "write" as const, path: input.path }],
      handler: (input: { path: string }) => {
        for (const p of resolves) resolveVaultPath(root, p === "$path" ? input.path : p);
        return { ok: true };
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal synthetic ToolDefinition for this test.
    } as any);
    const ctx = (): CallerContext => ({
      caller: "t",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "v",
      db: stubDb,
      acl,
    });
    return (path: string) => registry.dispatch(name, { vault: "v", path }, ctx());
  }

  it("no violation when the handler resolves exactly its declared path", async () => {
    const r = await call("mirror_ok", ["$path"])("declared.md");
    expect(r.ok).toBe(true);
    expect(getCollectedViolations()).toHaveLength(0);
  });

  it("flags a path the handler resolves that its pathAcl never declared", async () => {
    const r = await call("mirror_bad", ["other.md"])("declared.md");
    expect(r.ok).toBe(true); // "on" mode collects, does not throw
    expect(getCollectedViolations()).toEqual([{ tool: "mirror_bad", path: "other.md" }]);
  });

  it("does not flag cross-note-rewrite tools that intentionally touch extra paths", async () => {
    // move_note is in CROSS_NOTE_REWRITE_TOOLS: its backlink rewrites are a documented carve-out.
    const r = await call("move_note", ["$path", "some/backlink.md"])("moved.md");
    expect(r.ok).toBe(true);
    expect(getCollectedViolations()).toHaveLength(0);
  });

  it("strict mode fails the call the moment an uncovered path is resolved", async () => {
    setAclAuditMode("strict");
    const r = await call("mirror_strict", ["sneaky.md"])("declared.md");
    expect(r.ok).toBe(false);
  });

  it("is a no-op when disabled (zero production overhead)", async () => {
    setAclAuditMode("off");
    const r = await call("mirror_off", ["other.md"])("declared.md");
    expect(r.ok).toBe(true);
    expect(getCollectedViolations()).toHaveLength(0);
  });
});
