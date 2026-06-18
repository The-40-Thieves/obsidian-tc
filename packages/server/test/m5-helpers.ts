// Harness for M5 tool tests: a real temp vault, an in-memory cache DB on the committed
// schema, the M5 tools registered on a ToolRegistry (verifyElicit wired for HITL), a
// CallerContext factory, and an optional deterministic fake plur transport (per-route,
// capturing every request) so the plur proxy is exercised with no live plur. Mirrors
// m4-helpers; capture/memory/workspace need no bridge, so plur is opt-in per test.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolResult } from "@obsidian-tc/shared";
import { type AclConfigT, FolderAcl } from "../src/acl";
import { type FakeRequestInfo, type FakeRoute, fakeBridgeTransport } from "../src/bridge";
import type { Database } from "../src/db/types";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { argsHash } from "../src/hash";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { createPlurClient } from "../src/plur/client";
import { registerM5Tools } from "../src/tools/m5";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);

const PLUR_ENDPOINT = "http://127.0.0.1:7077";
export const PLUR_TOKEN = "plur-secret";

export interface M5VaultOptions {
  files?: Record<string, string>;
  acl?: Partial<AclConfigT>;
  memoryFolder?: string;
  traceFolder?: string;
  /** When set, a plur client is wired with these fake routes. Omit to leave plur
   *  unconfigured (its tools then degrade to plugin_missing with no network call). */
  plurRoutes?: Record<string, FakeRoute>;
  /** Force a configured plur client even with no routes (uses the 404 fallback). */
  plurConfigured?: boolean;
  vaultId?: string;
}

export interface M5EventRow {
  tool_name: string | null;
  status: string;
  error_code: string | null;
}

export interface M5Vault {
  root: string;
  id: string;
  db: Database;
  registry: ToolRegistry;
  acl: FolderAcl;
  /** Every request the fake plur transport received, in order. */
  plurRequests: FakeRequestInfo[];
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
  events(): M5EventRow[];
  cleanup(): void;
}

export function makeM5Vault(opts: M5VaultOptions = {}): M5Vault {
  const root = mkdtempSync(join(tmpdir(), "obtc-m5-"));
  const id = opts.vaultId ?? "test";
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (const [rel, content] of Object.entries(opts.files ?? {})) write(rel, content);

  const db = openMemoryDb();
  db.exec(schemaSql);
  const aclCfg: AclConfigT = { readOnly: false, defaultScopes: [], rules: [], ...opts.acl };
  const acl = new FolderAcl(aclCfg);
  const vaultRegistry = new VaultRegistry([{ id, path: root }]);

  const plurRequests: FakeRequestInfo[] = [];
  const configured = opts.plurConfigured || opts.plurRoutes !== undefined;
  const plur = configured
    ? createPlurClient({
        endpoint: PLUR_ENDPOINT,
        apiKey: PLUR_TOKEN,
        fetchFn: fakeBridgeTransport({
          routes: opts.plurRoutes ?? {},
          onRequest: (i) => plurRequests.push(i),
        }),
      })
    : undefined;

  const registry = new ToolRegistry({ verifyElicit: elicitVerifier });
  registerM5Tools(registry, {
    vaultRegistry,
    plur,
    memoryFolder: () => opts.memoryFolder ?? "memory",
    traceFolder: () => opts.traceFolder ?? ".obsidian-tc/traces",
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
    acl,
    plurRequests,
    write,
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
        .prepare("SELECT tool_name, status, error_code FROM event_log ORDER BY rowid")
        .all() as M5EventRow[],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
