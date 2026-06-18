// Harness for M6 tool tests (THE-182): a real temp vault, an in-memory cache DB on
// the committed schema, the M1 surface + a caller-chosen slice of M6 registered on
// one ToolRegistry (verifyElicit wired so the bulk HITL floor runs end-to-end), a
// CallerContext factory with an injectable clock (so the rate limiter is
// deterministic), and a shared RateLimiter. callConfirmed mints a single-use elicit
// token bound to argsHash(name, input) and supplies it via ctx — the canonical path
// (the token is never part of the tool input, which would change the args hash).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ServerConfigSchema, type ToolResult } from "@obsidian-tc/shared";
import { type AclConfigT, FolderAcl } from "../src/acl";
import type { CapabilitySnapshot } from "../src/bridge";
import type { Database } from "../src/db/types";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { argsHash } from "../src/hash";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { RateLimiter } from "../src/throttle";
import { registerM1Tools } from "../src/tools/m1";
import type { M6Deps } from "../src/tools/m6/shared";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);

const DEFAULT_THROTTLE = ServerConfigSchema.parse({ vaults: [{ id: "x", path: "/x" }] }).throttle;

export interface M6VaultOptions {
  files?: Record<string, string>;
  acl?: Partial<AclConfigT>;
  vaultId?: string;
  rateLimiter?: RateLimiter;
  now?: () => number;
  capabilities?: (vaultId: string) => CapabilitySnapshot;
  authMode?: "none" | "jwt" | "oauth";
  observability?: { otel: boolean; prometheus: boolean; morgiana: boolean };
  /** Which M6 tools to register; receives the registry and the built deps. */
  register: (registry: ToolRegistry, deps: M6Deps) => void;
}

export interface M6EventRow {
  tool_name: string | null;
  status: string;
  error_code: string | null;
}

export interface M6Vault {
  root: string;
  id: string;
  db: Database;
  registry: ToolRegistry;
  deps: M6Deps;
  rateLimiter: RateLimiter;
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
  events(): M6EventRow[];
  cleanup(): void;
}

export function makeM6Vault(opts: M6VaultOptions): M6Vault {
  const root = mkdtempSync(join(tmpdir(), "obtc-m6-"));
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
  const vaultRegistry = new VaultRegistry([{ id, name: id, path: root }]);
  const rateLimiter = opts.rateLimiter ?? new RateLimiter();

  const registry = new ToolRegistry({ verifyElicit: elicitVerifier });
  const deps: M6Deps = {
    vaultRegistry,
    rateLimiter,
    version: "test",
    startedAt: 0,
    authMode: opts.authMode ?? "none",
    throttle: DEFAULT_THROTTLE,
    observability: opts.observability ?? { otel: false, prometheus: false, morgiana: true },
    embeddingsProvider: "ollama",
    governorMaxResponseBytes: 1_000_000,
    capabilities: opts.capabilities,
    registeredTools: () => registry.list().length,
  };
  registerM1Tools(registry, {
    vaultRegistry,
    version: "test",
    startedAt: 0,
    embeddings: { provider: "ollama", model: "nomic-embed-text" },
  });
  opts.register(registry, deps);

  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: id,
    db,
    acl,
    now: opts.now,
    ...over,
  });

  return {
    root,
    id,
    db,
    registry,
    deps,
    rateLimiter,
    acl,
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
        .prepare("SELECT tool_name, status, error_code FROM event_log ORDER BY id")
        .all() as M6EventRow[],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
