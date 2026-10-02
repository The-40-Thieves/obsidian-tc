// Shared harness for M1 tool tests + the live-vault integration test. Spins up a
// real temp vault on disk, an in-memory cache DB on the committed schema, a
// ToolRegistry with the M1 tools registered (verifyElicit wired so the HITL
// cycle runs end-to-end through dispatch), and a CallerContext factory.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ResponseFormat,
  ToolResult,
  VaultMemoryDefenseConfig,
} from "@the-40-thieves/obsidian-tc-shared";
import { type AclConfigT, FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { elicitVerifier } from "../src/elicit";
import { createPagingDeps } from "../src/mcp/byte-page";
import { type CallerContext, type RegistryOptions, ToolRegistry } from "../src/mcp/registry";
import type { MetricsRecorder } from "../src/metrics/registry";
import type { KeyResolver } from "../src/provenance/signer";
import { registerM1Tools } from "../src/tools/m1";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

export interface TestVaultOptions {
  files?: Record<string, string>;
  acl?: Partial<AclConfigT>;
  vaultId?: string;
  snapshots?: { enabled: boolean; retention: number };
  requireCas?: boolean;
  /** GH #1027: the operator default (`tools.defaults.responseFormat`) a call naming no format gets. */
  responseFormat?: ResponseFormat;
  /** Index-coordinator hook. Unwired by default; a test that needs to fault the post-write step
   *  supplies a throwing one (THE-572). */
  reindex?: (vaultId: string, path: string, content: string) => void;
  /** THE-603: legibility signal for a no-op snapshot capture. Unwired by default, like reindex. */
  onSnapshotSkipped?: (vaultId: string, path: string, op: string) => void;
  /** THE-643 item 1: open experiential.db handle for write_note/append_note/patch_note's
   *  quality_warning point read. Unwired by default -> quality_warning is always null. */
  edb?: Database;
  /** GH #994 follow-up: memoryDefense config for write_note/append_note/patch_note. Unwired by
   *  default -> the tools scan nothing (MEMORY_DEFENSE_OFF), matching a vault with no config. */
  memoryDefense?: VaultMemoryDefenseConfig;
  metrics?: MetricsRecorder;
  /** The governor byte budget (ToolRegistry maxResponseBytes); also the size bulk-read pages are
   *  cut to. Default: the registry's 1 MB. */
  maxResponseBytes?: number;
  /** Wire dispatch's central folder-ACL stage (rootResolver), as production does. Off by default:
   *  the older M1 tests exercise the handler-side ACL only. */
  centralAcl?: boolean;
  /** Per-vault ACL overrides, wired as the registry's `aclResolver` exactly as governance.ts does
   *  (`aclByVault.get(id) ?? root`). The `acl` option stays the ROOT ACL the caller's context
   *  carries, so a test can pair a permissive root with a narrowing per-vault override. */
  aclByVault?: Record<string, Partial<AclConfigT>>;
  /** get_provenance's include_verification: the registry's public keys. Unwired by default. */
  provenanceKeys?: () => KeyResolver | undefined;
  /** get_provenance's per-query row budget (`provenance.query.maxScanRows`). Default: the tool's. */
  provenanceMaxScanRows?: number;
  /** `vaults[].wiki.folder` for the vault. */
  wikiFolder?: string;
  /** `vaults[].wiki.log.attribution` for the vault. */
  wikiLogAttribution?: boolean;
  /** Extra registry options (metrics, emit, rateLimiter, toolVisibility...). */
  registryOpts?: Partial<RegistryOptions>;
}

export interface EventRow {
  tool_name: string;
  status: string;
  error_code: string | null;
  event_type: string | null;
}

export interface TestVault {
  root: string;
  id: string;
  db: Database;
  registry: ToolRegistry;
  vaultRegistry: VaultRegistry;
  acl: FolderAcl;
  write(rel: string, content: string): void;
  read(rel: string): string;
  exists(rel: string): boolean;
  ctx(over?: Partial<CallerContext>): CallerContext;
  call(
    name: string,
    input: Record<string, unknown>,
    over?: Partial<CallerContext>,
  ): Promise<ToolResult>;
  events(): EventRow[];
  cleanup(): void;
}

export function makeTestVault(opts: TestVaultOptions = {}): TestVault {
  const root = makeTempDir("obtc-vault-");
  const id = opts.vaultId ?? "test";
  const writeFile = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (const [rel, content] of Object.entries(opts.files ?? {})) writeFile(rel, content);

  const db = openMemoryDb();
  provisionCacheDb(db);
  const aclCfg: AclConfigT = { readOnly: false, defaultScopes: [], rules: [], ...opts.acl };
  const acl = new FolderAcl(aclCfg);
  const vaultRegistry = new VaultRegistry([
    {
      id,
      path: root,
      ...(opts.wikiFolder
        ? {
            wiki: {
              folder: opts.wikiFolder,
              ...(opts.wikiLogAttribution !== undefined
                ? { log: { attribution: opts.wikiLogAttribution } }
                : {}),
            },
          }
        : {}),
    },
  ]);
  const overrides = new Map(
    Object.entries(opts.aclByVault ?? {}).map(([vid, cfg]) => [
      vid,
      new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], ...cfg }),
    ]),
  );
  const registry = new ToolRegistry({
    verifyElicit: elicitVerifier,
    ...(opts.aclByVault ? { aclResolver: (vid: string) => overrides.get(vid) ?? acl } : {}),
    ...opts.registryOpts,
    ...(opts.centralAcl ? { rootResolver: () => root } : {}),
    ...(opts.maxResponseBytes !== undefined ? { maxResponseBytes: opts.maxResponseBytes } : {}),
  });
  registerM1Tools(registry, {
    vaultRegistry,
    version: "test",
    startedAt: 0,
    embeddings: { provider: "ollama", model: "nomic-embed-text" },
    snapshots: opts.snapshots,
    requireCas: opts.requireCas,
    ...(opts.responseFormat ? { responseFormat: opts.responseFormat } : {}),
    ...(opts.reindex ? { reindex: opts.reindex } : {}),
    ...(opts.onSnapshotSkipped ? { onSnapshotSkipped: opts.onSnapshotSkipped } : {}),
    ...(opts.edb ? { edb: opts.edb } : {}),
    ...(opts.memoryDefense
      ? { memoryDefense: () => opts.memoryDefense as VaultMemoryDefenseConfig }
      : {}),
    ...(opts.metrics ? { metrics: opts.metrics } : {}),
    ...(opts.provenanceKeys ? { provenanceKeys: opts.provenanceKeys } : {}),
    ...(opts.provenanceMaxScanRows !== undefined
      ? { provenanceMaxScanRows: opts.provenanceMaxScanRows }
      : {}),
    paging: createPagingDeps({
      secret: "test-secret",
      budgetBytes: () => registry.maxResponseBytes,
    }),
  });

  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: id,
    db,
    acl,
    ...over,
  });

  return {
    root,
    id,
    db,
    registry,
    vaultRegistry,
    acl,
    write: writeFile,
    read: (rel) => readFileSync(join(root, rel), "utf8"),
    exists: (rel) => existsSync(join(root, rel)),
    ctx,
    call: (name, input, over) => registry.dispatch(name, input, ctx(over)),
    events: () =>
      db
        .prepare("SELECT tool_name, status, error_code, event_type FROM event_log ORDER BY id")
        .all() as EventRow[],
    cleanup: () => rmTemp(root),
  };
}
