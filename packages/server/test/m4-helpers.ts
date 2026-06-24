// Harness for M4 tests: a real temp vault, an in-memory cache DB on the committed
// schema, a deterministic fake bridge transport (programmable per-route, capturing
// every request), an injected per-vault capability snapshot, and a ToolRegistry
// with the M4 tools registered. No live Obsidian, no companion runtime, no
// community plugin — everything proxy-side is exercised through the fake. The
// CallerContext grants all scopes; callConfirmed mints + supplies an elicit token
// for HITL-gated tools.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { type AclConfigT, FolderAcl } from "../src/acl";
import {
  CapabilityCache,
  type CapabilitySnapshot,
  createBridgeClient,
  type FakeRequestInfo,
  type FakeRoute,
  fakeBridgeTransport,
} from "../src/bridge";
import type { Database } from "../src/db/types";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { argsHash } from "../src/hash";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { registerM4Tools } from "../src/tools/m4";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);

const BASE = "http://127.0.0.1:27124";

export interface M4VaultOptions {
  files?: Record<string, string>;
  acl?: Partial<AclConfigT>;
  /** Programmable fake bridge routes, keyed "METHOD /obsidian-tc/v1/...". */
  routes?: Record<string, FakeRoute>;
  /** Full capability snapshot; takes precedence over `installed`. */
  snapshot?: CapabilitySnapshot;
  /** Convenience: companion reachable with these community plugins installed. */
  installed?: string[];
  /** When true, no bridge client is wired (bridgeFor returns undefined). */
  noBridge?: boolean;
  /** Per-vault command-palette execution policy (deny-by-default when omitted). */
  commandPolicy?: (vaultId: string) => { enabled: boolean; allowlist: string[] };
  vaultId?: string;
}

export interface M4EventRow {
  tool_name: string | null;
  status: string;
  error_code: string | null;
}

export interface M4Vault {
  root: string;
  id: string;
  db: Database;
  registry: ToolRegistry;
  acl: FolderAcl;
  capabilities: CapabilityCache;
  /** Every request the fake bridge transport received, in order. */
  bridgeRequests: FakeRequestInfo[];
  write(rel: string, content: string): void;
  read(rel: string): string;
  exists(rel: string): boolean;
  ctx(over?: Partial<CallerContext>): CallerContext;
  call(
    name: string,
    input: Record<string, unknown>,
    over?: Partial<CallerContext>,
  ): Promise<ToolResult>;
  /** Dispatch with a freshly minted elicit token bound to (name, input). */
  callConfirmed(
    name: string,
    input: Record<string, unknown>,
    over?: Partial<CallerContext>,
  ): Promise<ToolResult>;
  events(): M4EventRow[];
  cleanup(): void;
}

export function makeM4Vault(opts: M4VaultOptions = {}): M4Vault {
  const root = mkdtempSync(join(tmpdir(), "obtc-m4-"));
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

  const snapshot: CapabilitySnapshot = opts.snapshot ?? {
    companion: "reachable",
    plugins: Object.fromEntries((opts.installed ?? []).map((p) => [p, { installed: true }])),
  };
  const capabilities = new CapabilityCache();
  capabilities.set(id, snapshot);

  const bridgeRequests: FakeRequestInfo[] = [];
  const fetchFn = fakeBridgeTransport({
    routes: opts.routes ?? {},
    onRequest: (i) => bridgeRequests.push(i),
  });
  const client = opts.noBridge
    ? undefined
    : createBridgeClient({ baseUrl: BASE, apiKey: "test-key", fetchFn });

  const registry = new ToolRegistry({ verifyElicit: elicitVerifier });
  registerM4Tools(registry, {
    vaultRegistry,
    capabilities,
    bridgeFor: () => client,
    ...(opts.commandPolicy ? { commandPolicy: opts.commandPolicy } : {}),
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
    capabilities,
    bridgeRequests,
    write,
    read: (rel) => readFileSync(join(root, rel), "utf8"),
    exists: (rel) => {
      try {
        readFileSync(join(root, rel));
        return true;
      } catch {
        return false;
      }
    },
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
        .all() as M4EventRow[],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
