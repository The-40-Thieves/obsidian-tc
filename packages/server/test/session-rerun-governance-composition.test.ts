// THE-645 item 3, fix round 1, finding 4 — compose `withReadOnlyAcl` with the REAL `wireGovernance`.
//
// Every other test covering this branch's safety mechanism either exercises the pure config
// transform (`withReadOnlyAcl` alone, session-rerun.test.ts) or a HAND-BUILT registry shaped like
// production (`new ToolRegistry({ aclResolver: () => acl })`, session-rerun-production-acl.test.ts,
// following the THE-295 `per-vault-acl.test.ts` idiom). Neither one ever calls the actual
// `wireGovernance` (runtime/governance.ts) that `buildServerRuntime` calls in production. That
// `aclResolver: (vaultId) => aclByVault.get(vaultId) ?? acl` is really what `wireGovernance` derives
// from `deps.acl`/`deps.vaults[].acl` has, until this file, been established ONLY by reading the
// source — a rename or a dropped `?? acl` fallback in governance.ts would be caught by nothing.
//
// `Governance` (the return type of `wireGovernance`) exposes `acl: FolderAcl` and
// `aclByVault: Map<string, FolderAcl>` directly (governance.ts:61-79) — the exact two values the
// resolver closure reads. `ToolRegistry` keeps the resolver itself `private` (mcp/registry.ts:82),
// so no test anywhere can assert on the closure as a VALUE; what CAN be proven, and what this file
// proves two ways, is its effect:
//
//  1. Direct: feed a `withReadOnlyAcl`-forced config into the real `wireGovernance` and read
//     `governance.acl` / `governance.aclByVault` straight off the result.
//  2. Behavioral: register M1 tools onto `governance.registry` (the same live `ToolRegistry`
//     `wireGovernance` constructed, with its real `aclResolver` wired at construction) and dispatch
//     a mutating call against BOTH a vault carrying its own acl block and one that has none — no
//     ctx.acl override supplied by the test, so the ONLY thing that can refuse the write is the
//     registry's own resolver.
//
// Deliberately NOT going through `buildServerRuntime`/`wireRuntimeCore`: those additionally build
// index resources (a working embeddings provider, vec/fts, …), which is real weight this test does
// not need to pull in — `wireGovernance` is the one function that actually decides the ACL question,
// and it is exported and callable in isolation.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withReadOnlyAcl } from "../src/cli/commands/rerun";
import { finalizeConfig } from "../src/config/load";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { MetricsRecorder } from "../src/metrics/registry";
import { type Governance, wireGovernance } from "../src/runtime/governance";
import { registerM1Tools } from "../src/tools/m1";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const WITH_OWN = "with-own";
const NO_OWN = "no-own";

/** Two real vault roots on disk (patch_note writes for real) plus a `withReadOnlyAcl`-forced
 *  config naming both — one vault (`withOwn`) carries its own acl block, one (`noOwn`) does not,
 *  matching the exact shape the file header says was previously unproven end-to-end. */
function buildForcedConfig(): {
  cfg: ReturnType<typeof finalizeConfig>;
  rootFor: Record<string, string>;
} {
  const rootWithOwn = mkdtempSync(join(tmpdir(), "obtc-gov-withown-"));
  const rootNoOwn = mkdtempSync(join(tmpdir(), "obtc-gov-noown-"));
  for (const [root, rel] of [
    [rootWithOwn, "a.md"],
    [rootNoOwn, "a.md"],
  ] as const) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "original");
  }
  const cfg = finalizeConfig({
    vaults: [
      {
        id: WITH_OWN,
        path: rootWithOwn,
        acl: { readOnly: false, defaultScopes: [], rules: [] },
      },
      { id: NO_OWN, path: rootNoOwn },
    ],
  });
  return { cfg: withReadOnlyAcl(cfg), rootFor: { [WITH_OWN]: rootWithOwn, [NO_OWN]: rootNoOwn } };
}

/** `wireGovernance` deps built the same way `buildServerRuntime` builds them (server-runtime.ts's
 *  `wireRuntimeCore` call, `vaults: config.vaults` / `acl: config.acl` straight through) — not a
 *  hand-picked subset, so this stays in step with production's own wiring. */
function governanceFor(cfg: ReturnType<typeof finalizeConfig>): {
  governance: Governance;
  db: Database;
} {
  const db: Database = openMemoryDb();
  provisionCacheDb(db);
  const governance = wireGovernance({
    db,
    cacheDir: cfg.cacheDir,
    vaults: cfg.vaults,
    acl: cfg.acl,
    defaultVaultId: undefined,
    elicitTtlSeconds: cfg.elicitTtlSeconds,
    throttle: cfg.throttle,
    maxResponseBytes: cfg.governor.maxResponseBytes,
    idempotencyTtlSeconds: cfg.idempotencyTtlSeconds,
    idempotencyReclaimSeconds: cfg.idempotencyReclaimSeconds,
    toolVisibility: cfg.toolVisibility,
    metrics: new MetricsRecorder(),
    tracer: undefined,
    morgiana: { emit: () => {} },
    getAuditWriteFailureCounter: () => ({ auditWriteFailures: 0 }),
  });
  return { governance, db };
}

describe("THE-645 item 3 fix round 1, finding 4 — withReadOnlyAcl composed with the real wireGovernance", () => {
  const tmpRoots: string[] = [];
  afterEach(() => {
    for (const d of tmpRoots.splice(0)) rmTemp(d);
  });

  it("wireGovernance derives BOTH governance.acl and governance.aclByVault as read-only from a withReadOnlyAcl-forced config", () => {
    const { cfg, rootFor } = buildForcedConfig();
    tmpRoots.push(rootFor[WITH_OWN] as string, rootFor[NO_OWN] as string);
    const { governance } = governanceFor(cfg);

    // Root ACL — inherited by any vault with no override of its own.
    expect(governance.acl.readOnly).toBe(true);
    // The vault that carries its OWN acl block: withReadOnlyAcl must have forced THIS one too, or
    // `aclByVault.get(vaultId) ?? acl` (governance.ts's real resolver formula) returns it un-forced
    // and the root-level forcing above is moot for this vault.
    expect(governance.aclByVault.get(WITH_OWN)?.readOnly).toBe(true);
    // The vault with NO acl block of its own is correctly absent from aclByVault (wireGovernance
    // only populates entries for vaults that HAD one — governance.ts's `.filter((v) => v.acl !==
    // undefined)`), so it falls through to the now-forced root via the resolver's `?? acl`.
    expect(governance.aclByVault.has(NO_OWN)).toBe(false);
  });

  it("end-to-end: the real wireGovernance-built registry refuses a write for BOTH the per-vault-acl vault and the fallback-to-root vault", async () => {
    const { cfg, rootFor } = buildForcedConfig();
    tmpRoots.push(rootFor[WITH_OWN] as string, rootFor[NO_OWN] as string);
    const { governance, db } = governanceFor(cfg);

    // No M1 registration happens inside wireGovernance itself (that stays in tool-wiring.ts /
    // cli.ts by design — see governance.ts's own header comment), so this test registers them the
    // same way production eventually does, onto the SAME live registry wireGovernance built —
    // `governance.vaultRegistry`, not a second hand-built one.
    registerM1Tools(governance.registry, {
      vaultRegistry: governance.vaultRegistry,
      version: "test",
      startedAt: 0,
      embeddings: { provider: "ollama", model: "nomic-embed-text" },
    });

    for (const vaultId of [WITH_OWN, NO_OWN]) {
      const res = (await governance.registry.dispatch(
        "patch_note",
        {
          vault: vaultId,
          path: "a.md",
          operation: "append",
          anchor: { type: "frontmatter" },
          content: "OVERWRITTEN",
        },
        {
          caller: "gov-composition-test",
          authenticated: true,
          grantedScopes: new Set(["*"]),
          vaultId,
          db,
          // Deliberately NO ctx.acl here — unlike rerun.ts's own per-call value, this test's whole
          // point is that the registry's WIRED aclResolver is what refuses the write, with nothing
          // else in play.
        },
      )) as { ok: boolean; error?: { code?: string } };

      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("forbidden");
      expect(
        readFileSync(join((rootFor as Record<string, string>)[vaultId] as string, "a.md"), "utf8"),
      ).toBe("original");
    }
  });
});
