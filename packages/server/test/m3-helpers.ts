// Harness for M3 tests: a real temp vault on disk, an in-memory cache DB on the
// committed schema, a ToolRegistry with the M3 tools registered (verifyElicit wired
// so the HITL elicit cycle runs end-to-end through dispatch), and a CallerContext
// factory granting all scopes. Mirrors makeTestVault (M1) / makeM2Vault (M2).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { type AclConfigT, FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { argsHash } from "../src/hash";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { type M3Deps, registerM3Tools } from "../src/tools/m3";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

export interface M3VaultOptions {
  files?: Record<string, string>;
  acl?: Partial<AclConfigT>;
  vaultId?: string;
  templaterBridge?: M3Deps["templaterBridge"];
}

export interface EventRow {
  tool_name: string;
  status: string;
  error_code: string | null;
}

export interface M3Vault {
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
  callConfirmed(
    name: string,
    input: Record<string, unknown>,
    over?: Partial<CallerContext>,
  ): Promise<ToolResult>;
  events(): EventRow[];
  cleanup(): void;
}

export function makeM3Vault(opts: M3VaultOptions = {}): M3Vault {
  const root = mkdtempSync(join(tmpdir(), "obtc-m3-"));
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
  const vaultRegistry = new VaultRegistry([{ id, path: root }]);
  const registry = new ToolRegistry({ verifyElicit: elicitVerifier });
  registerM3Tools(registry, {
    vaultRegistry,
    ...(opts.templaterBridge ? { templaterBridge: opts.templaterBridge } : {}),
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
    callConfirmed: (name, input, over) => {
      const token = issueElicitToken(db, {
        vaultId: id,
        toolName: name,
        argsHash: argsHash(name, input),
        caller: "test",
      });
      return registry.dispatch(name, input, ctx({ elicitToken: token, ...over }));
    },
    events: () =>
      db
        .prepare("SELECT tool_name, status, error_code FROM event_log ORDER BY id")
        .all() as EventRow[],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
