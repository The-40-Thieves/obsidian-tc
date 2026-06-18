// Harness for M2 tests: a real temp vault on disk, an in-memory cache DB on the
// committed schema, a ToolRegistry with the M2 tools registered against an
// injected deterministic fake embedding provider (no live service), and a
// CallerContext factory granting all scopes.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolResult } from "@obsidian-tc/shared";
import { type AclConfigT, FolderAcl } from "../src/acl";
import type { Database } from "../src/db/types";
import { type EmbeddingProvider, fakeEmbeddingProvider } from "../src/embeddings";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { registerM2Tools } from "../src/tools/m2";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);

export interface M2VaultOptions {
  files?: Record<string, string>;
  acl?: Partial<AclConfigT>;
  provider?: EmbeddingProvider;
  vaultId?: string;
}

export interface M2Vault {
  root: string;
  id: string;
  db: Database;
  registry: ToolRegistry;
  provider: EmbeddingProvider;
  acl: FolderAcl;
  write(rel: string, content: string): void;
  ctx(over?: Partial<CallerContext>): CallerContext;
  call(
    name: string,
    input: Record<string, unknown>,
    over?: Partial<CallerContext>,
  ): Promise<ToolResult>;
  cleanup(): void;
}

export function makeM2Vault(opts: M2VaultOptions = {}): M2Vault {
  const root = mkdtempSync(join(tmpdir(), "obtc-m2-"));
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
  const provider = opts.provider ?? fakeEmbeddingProvider({ dimensions: 32 });
  const registry = new ToolRegistry();
  registerM2Tools(registry, { vaultRegistry, embeddingProvider: provider });

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
    provider,
    acl,
    write,
    ctx,
    call: (name, input, over) => registry.dispatch(name, input, ctx(over)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
