// Shared fixture for the read-ACL parity tests (search-acl-parity / content-leak-parity): three
// indexed vaults, one rule-scoped note, the read_notes ORACLE and the assertNoLeak scan. Each parity
// file owns its surface list; this owns what "a leak" means so the two cannot drift.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { registerM1Tools } from "../src/tools/m1";
import { registerM2Tools } from "../src/tools/m2";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

export const MAIN = "main";
export const OTHER = "other";
export const DOCS = "docs";
export const HIDDEN = "secret/b.md";
export const MARK = "SECRETMARK";
export const ALL_PATHS = ["pub/a.md", HIDDEN, "open/c.md"];

export const FILES: Record<string, string> = {
  "pub/a.md":
    "---\ntags: [topic]\nkind: memo\nseverity: critical\n---\n# A\n\nzebra public note links [[secret/b]] and [[open/c]]\n",
  [HIDDEN]: `---\ntags: [topic]\nkind: memo\nseverity: critical\n---\n# B\n\nzebra ${MARK} confidential note links [[open/c]] and [[pub/a]]\n`,
  "open/c.md":
    "---\ntags: [topic]\nkind: memo\nseverity: critical\n---\n# C\n\nzebra open note with no outgoing links\n",
};

export const RULE_SCOPE: Partial<AclConfigT> = {
  rules: [{ glob: "secret/**", scopes: ["read:secret"] }],
};
export const BASE_SCOPES = ["read:notes", "read:docs", "read:vault"];

export interface Harness {
  registry: ToolRegistry;
  ctx: (scopes: string[], over?: Partial<CallerContext>) => CallerContext;
  call: (
    name: string,
    input: Record<string, unknown>,
    scopes: string[],
    over?: Partial<CallerContext>,
  ) => Promise<{ ok: boolean; data?: any; error?: { code: string } }>;
  cleanup: () => void;
  parts: HarnessParts;
}

export interface AclSpec {
  main?: Partial<AclConfigT>;
  other?: Partial<AclConfigT>;
  docs?: Partial<AclConfigT>;
}

/** Everything a caller-supplied `extra` registration needs to wire more tool families onto the
 *  same three-vault fixture (same roots, same cache DB, same per-vault ACLs). */
export interface HarnessParts {
  roots: string[];
  db: any;
  vaultRegistry: VaultRegistry;
  aclByVault: Map<string, FolderAcl>;
  rootAcl: FolderAcl;
}

async function build(acls: AclSpec, extra?: (registry: ToolRegistry, parts: HarnessParts) => void) {
  const roots = [MAIN, OTHER, DOCS].map((id) => mkdtempSync(join(tmpdir(), `obtc-parity-${id}-`)));
  for (const root of roots)
    for (const [rel, content] of Object.entries(FILES)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  const db = openMemoryDb();
  provisionCacheDb(db);
  const provider = fakeEmbeddingProvider({ dimensions: 32 });
  const representation = buildRepresentationManifest(provider, {});
  const ids = [MAIN, OTHER, DOCS];
  for (const [i, vaultId] of ids.entries())
    await indexVault({
      db,
      provider,
      representation,
      vaultId,
      root: roots[i] as string,
      // Index time is caller-independent: everything is indexed, retrieval filters.
      isReadable: () => true,
    });
  const cfg = (over?: Partial<AclConfigT>): AclConfigT => ({
    readOnly: false,
    defaultScopes: [],
    rules: [],
    ...over,
  });
  const rootAcl = new FolderAcl(cfg(acls.main));
  const aclByVault = new Map<string, FolderAcl>([
    [MAIN, rootAcl],
    [OTHER, new FolderAcl(cfg(acls.other ?? acls.main))],
    [DOCS, new FolderAcl(cfg(acls.docs ?? acls.main))],
  ]);
  const vaultRegistry = new VaultRegistry([
    { id: MAIN, path: roots[0] as string },
    { id: OTHER, path: roots[1] as string },
    { id: DOCS, path: roots[2] as string, kind: "docs" },
  ]);
  // The same three resolvers runtime/governance.ts wires: without rootResolver central pathAcl
  // enforcement (the read_notes oracle below) silently skips.
  const registry = new ToolRegistry({
    aclResolver: (id) => aclByVault.get(id) ?? rootAcl,
    rootResolver: (id) => vaultRegistry.resolve(id).root,
    vaultKindResolver: (id) => vaultRegistry.resolve(id).kind,
  });
  registerM1Tools(registry, {
    vaultRegistry,
    version: "0.0.0",
    startedAt: 0,
    embeddings: { provider: provider.provider, model: provider.model },
  });
  registerM2Tools(registry, { vaultRegistry, embeddingProvider: provider, representation });
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider: provider,
    reranker: null,
    roles: null,
    acl: rootAcl,
    aclByVault,
  });
  extra?.(registry, { roots, db, vaultRegistry, aclByVault, rootAcl });
  const ctx = (scopes: string[], over: Partial<CallerContext> = {}): CallerContext => ({
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(scopes),
    vaultId: MAIN,
    db,
    ...over,
  });
  const h: Harness = {
    registry,
    ctx,
    call: (name, input, scopes, over) =>
      registry.dispatch(name, input, ctx(scopes, over)) as Promise<any>,
    cleanup: () => {
      for (const r of roots) rmTemp(r);
    },
    parts: { roots, db, vaultRegistry, aclByVault, rootAcl },
  };
  return h;
}

/** Call once at the top of a test file: builds harnesses that are torn down after each test. */
export function useHarness(): (
  acls: AclSpec,
  extra?: (registry: ToolRegistry, parts: HarnessParts) => void,
) => Promise<Harness> {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });
  return async (acls, extra) => {
    const h = await build(acls, extra);
    cleanups.push(h.cleanup);
    return h;
  };
}

/** Every string anywhere in a tool result. Snippets, chunk text, paths, backlink sources, error
 *  details: a hidden note may surface through any of them. */
export function strings(v: unknown, skip: readonly string[] = [], out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, skip, out);
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) if (!skip.includes(k)) strings(x, skip, out);
  return out;
}

/** True when a result names the hidden note or carries its text. A readable note's OWN text may
 *  mention `secret/b` (a wikilink), so the path is matched whole, never as a substring. */
export function leaks(data: unknown): boolean {
  return strings(data).some((x) => x === HIDDEN || x.includes(MARK));
}

/** The oracle: what read_notes allows this principal, per path, on this vault. */
export async function readNotesAllows(
  h: Harness,
  vault: string,
  scopes: string[],
  over?: Partial<CallerContext>,
): Promise<Set<string>> {
  const allowed = new Set<string>();
  for (const p of ALL_PATHS) {
    const r = await h.call("read_notes", { vault, paths: [p] }, scopes, over);
    if (r.ok && r.data.notes.length === 1) allowed.add(p);
  }
  return allowed;
}

/** Assert one surface returns nothing the oracle refuses: no path, no chunk text, no snippet. */
export function assertNoLeak(
  surface: string,
  data: unknown,
  allowed: Set<string>,
  echoKeys: readonly string[] = [],
): void {
  const all = strings(data, echoKeys);
  for (const p of ALL_PATHS) {
    if (allowed.has(p)) continue;
    const hit = all.find((s) => s === p || s.endsWith(`/${p}`) || s.includes(`${p}`));
    expect(hit, `${surface}: hidden path ${p} surfaced as ${JSON.stringify(hit)}`).toBeUndefined();
  }
  if (!allowed.has(HIDDEN)) {
    const hit = all.find((s) => s.includes(MARK));
    expect(hit, `${surface}: hidden note text surfaced`).toBeUndefined();
  }
}
