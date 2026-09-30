// Read-ACL parity across every search / enumeration surface.
//
// The bug class: `readableRel` (the predicate every result filter uses) checked the folder
// whitelist (readPaths / strictReadDefault) but ignored the caller's granted scopes, so a note under
// a rule-scope (`secret/**` requiring `read:secret`) that read_note / read_notes REFUSE still came
// back from search as a path, a snippet, a backlink or a count. This file holds the ONE oracle —
// what read_notes allows for the same principal — and asserts that every surface returns only
// paths inside it, across the ACL shapes that can differ:
//   rule-scope without the scope, rule-scope with it, strictReadDefault, a readPaths override on
//   one vault, and a vault-bound caller reaching across vaults.
// Every surface also runs a POSITIVE control (the scope is granted, the hidden note must appear) so
// a surface that returns nothing at all cannot pass as "no leak".
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

const MAIN = "main";
const OTHER = "other";
const DOCS = "docs";
const HIDDEN = "secret/b.md";
const MARK = "SECRETMARK";
const ALL_PATHS = ["pub/a.md", HIDDEN, "open/c.md"];

const FILES: Record<string, string> = {
  "pub/a.md":
    "---\ntags: [topic]\nkind: memo\nseverity: critical\n---\n# A\n\nzebra public note links [[secret/b]] and [[open/c]]\n",
  [HIDDEN]: `---\ntags: [topic]\nkind: memo\nseverity: critical\n---\n# B\n\nzebra ${MARK} confidential note links [[open/c]] and [[pub/a]]\n`,
  "open/c.md":
    "---\ntags: [topic]\nkind: memo\nseverity: critical\n---\n# C\n\nzebra open note with no outgoing links\n",
};

const RULE_SCOPE: Partial<AclConfigT> = {
  rules: [{ glob: "secret/**", scopes: ["read:secret"] }],
};
const BASE_SCOPES = ["read:notes", "read:docs", "read:vault"];

interface Harness {
  registry: ToolRegistry;
  ctx: (scopes: string[], over?: Partial<CallerContext>) => CallerContext;
  call: (
    name: string,
    input: Record<string, unknown>,
    scopes: string[],
    over?: Partial<CallerContext>,
  ) => Promise<{ ok: boolean; data?: any; error?: { code: string } }>;
  cleanup: () => void;
}

async function build(acls: { main?: Partial<AclConfigT>; other?: Partial<AclConfigT> }) {
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
    [DOCS, new FolderAcl(cfg(acls.main))],
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
  };
  return h;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});
async function harness(acls: Parameters<typeof build>[0]): Promise<Harness> {
  const h = await build(acls);
  cleanups.push(h.cleanup);
  return h;
}

/** Every string anywhere in a tool result. Snippets, chunk text, paths, backlink sources, error
 *  details: a hidden note may surface through any of them. */
function strings(v: unknown, skip: readonly string[] = [], out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, skip, out);
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) if (!skip.includes(k)) strings(x, skip, out);
  return out;
}

/** True when a result names the hidden note or carries its text. A readable note's OWN text may
 *  mention `secret/b` (a wikilink), so the path is matched whole, never as a substring. */
function leaks(data: unknown): boolean {
  return strings(data).some((x) => x === HIDDEN || x.includes(MARK));
}

interface Surface {
  name: string;
  tool: string;
  input: (vault: string) => Record<string, unknown>;
  /** Result fields that hold a count/total which must not include hidden matches. */
  totals?: (data: any) => number[];
  /** Keys whose value is the caller's OWN readable note text echoed back (a link's raw target),
   *  which may legitimately name a path the caller cannot read. */
  echoKeys?: readonly string[];
  /** The scoped caller does not see MORE items (orphan lists shrink when a hidden note links in). */
  notMore?: boolean;
  /** How many items a full result holds (used with the totals check). */
  items?: (data: any) => number;
  vault?: string;
}

const Q = { query: "zebra" };
/** Surfaces whose payload is counts / lists without a path: covered by the differential check. */
const AGGREGATE_ONLY = new Set([
  "list_tags",
  "list_properties",
  "find_orphans",
  "find_unresolved_links",
]);
const SURFACES: Surface[] = [
  {
    name: "search_text",
    tool: "search_text",
    input: (vault) => ({ vault, ...Q }),
    totals: (d) => [d.total],
    items: (d) => d.items.length,
  },
  {
    name: "search_regex",
    tool: "search_regex",
    input: (vault) => ({ vault, pattern: "zebra" }),
    totals: (d) => [d.total],
    items: (d) => d.items.length,
  },
  {
    name: "search_semantic",
    tool: "search_semantic",
    input: (vault) => ({ vault, ...Q, k: 50 }),
    items: (d) => d.items.length,
  },
  {
    name: "search_jsonlogic",
    tool: "search_jsonlogic",
    input: (vault) => ({ vault, logic: { in: ["zebra", { var: "content" }] } }),
    totals: (d) => [d.total],
    items: (d) => d.items.length,
  },
  ...(["auto", "text", "regex", "semantic"] as const).map(
    (mode): Surface => ({
      name: `search_vault(${mode})`,
      tool: "search_vault",
      input: (vault) => ({ vault, query: "zebra", mode }),
      totals: (d) => [d.total],
      items: (d) => d.items.length,
    }),
  ),
  {
    name: "search_vault(jsonlogic)",
    tool: "search_vault",
    input: (vault) => ({ vault, query: { in: ["zebra", { var: "content" }] }, mode: "jsonlogic" }),
    totals: (d) => [d.total],
    items: (d) => d.items.length,
  },
  {
    name: "vault_graph_search",
    tool: "vault_graph_search",
    input: (vault) => ({ vault, ...Q, final_top_k: 50 }),
    items: (d) => d.results.length,
  },
  {
    name: "vault_graph_search(class router off, multi query)",
    tool: "vault_graph_search",
    input: (vault) => ({ vault, ...Q, queries: ["zebra note", "zebra"], final_top_k: 50 }),
    items: (d) => d.results.length,
  },
  ...(["note", "section"] as const).map(
    (mode): Surface => ({
      name: `search_and_read(${mode})`,
      tool: "search_and_read",
      input: (vault) => ({ vault, ...Q, k: 20, mode }),
      items: (d) => d.notes.length,
    }),
  ),
  {
    name: "knowledge_search",
    tool: "knowledge_search",
    input: () => ({ vault: DOCS, ...Q, final_top_k: 50 }),
    items: (d) => d.results.length,
    vault: DOCS,
  },
  {
    name: "vault_context",
    tool: "vault_context",
    input: (vault) => ({ vault, ...Q, token_budget: 8000 }),
  },
  {
    name: "knowledge_get_critical",
    tool: "knowledge_get_critical",
    input: () => ({ vault: DOCS }),
    vault: DOCS,
  },
  { name: "list_notes", tool: "list_notes", input: (vault) => ({ vault }) },
  {
    name: "find_notes_by_tag",
    tool: "find_notes_by_tag",
    input: (vault) => ({ vault, tag: "topic" }),
  },
  {
    name: "find_notes_by_property",
    tool: "find_notes_by_property",
    input: (vault) => ({ vault, key: "kind", value: "memo" }),
  },
  { name: "list_tags", tool: "list_tags", input: (vault) => ({ vault }) },
  { name: "list_properties", tool: "list_properties", input: (vault) => ({ vault }) },
  {
    name: "get_backlinks",
    tool: "get_backlinks",
    input: (vault) => ({ vault, path: "open/c.md" }),
    totals: (d) => [d.total],
    items: (d) => d.backlinks.length,
  },
  {
    name: "find_orphans",
    tool: "find_orphans",
    input: (vault) => ({ vault }),
    totals: (d) => [d.total],
    items: (d) => d.orphans.length,
    notMore: true,
  },
  {
    name: "find_unresolved_links",
    tool: "find_unresolved_links",
    input: (vault) => ({ vault }),
    echoKeys: ["target", "raw"],
  },
  {
    name: "suggest_links",
    tool: "suggest_links",
    input: (vault) => ({ vault, path: "open/c.md" }),
  },
  { name: "graph_centrality", tool: "graph_centrality", input: (vault) => ({ vault }) },
  { name: "graph_communities", tool: "graph_communities", input: (vault) => ({ vault }) },
];

/** The oracle: what read_notes allows this principal, per path, on this vault. */
async function readNotesAllows(
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
function assertNoLeak(
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

describe("rule-scope: the caller lacks the scope a path's rule requires", () => {
  it("the oracle refuses the hidden note and allows the rest", async () => {
    const h = await harness({ main: RULE_SCOPE });
    const allowed = await readNotesAllows(h, MAIN, BASE_SCOPES);
    expect([...allowed].sort()).toEqual(["open/c.md", "pub/a.md"]);
  });

  for (const s of SURFACES) {
    it(`${s.name} returns only what read_notes allows`, async () => {
      const h = await harness({ main: RULE_SCOPE });
      const vault = s.vault ?? MAIN;
      const allowed = await readNotesAllows(h, vault, BASE_SCOPES);
      const r = await h.call(s.tool, s.input(vault), BASE_SCOPES);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      assertNoLeak(s.name, r.data, allowed, s.echoKeys);
    });

    it(`${s.name} still returns the note once the scope is granted (positive control)`, async () => {
      const h = await harness({ main: RULE_SCOPE });
      const scopes = [...BASE_SCOPES, "read:secret"];
      const vault = s.vault ?? MAIN;
      const allowed = await readNotesAllows(h, vault, scopes);
      expect(allowed.has(HIDDEN)).toBe(true);
      const r = await h.call(s.tool, s.input(vault), scopes);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const denied = await h.call(s.tool, s.input(vault), BASE_SCOPES);
      // The scope must change what the caller sees: a surface that returns the same payload to
      // both callers is either leaking to one or hiding from the other. Aggregates (tag counts,
      // orphan lists) carry no path, so difference is the portable signal; path-bearing surfaces
      // must additionally show the note itself.
      expect(JSON.stringify(r.data), `${s.name}: scope changed nothing`).not.toBe(
        JSON.stringify(denied.data),
      );
      if (!AGGREGATE_ONLY.has(s.name))
        expect(
          strings(r.data, s.echoKeys).some((x) => x.includes("secret/b") || x.includes(MARK)),
          `${s.name}: expected the granted caller to see the scoped note`,
        ).toBe(true);
    });
  }

  it("a caller holding only one of two required scopes stays denied", async () => {
    const h = await harness({
      main: { rules: [{ glob: "secret/**", scopes: ["read:secret", "read:finance"] }] },
    });
    const scopes = [...BASE_SCOPES, "read:secret"];
    const r = await h.call("search_text", { vault: MAIN, ...Q }, scopes);
    expect(leaks(r.data)).toBe(false);
  });
});

describe("counts and totals do not reveal hidden matches", () => {
  for (const s of SURFACES.filter((x) => x.totals)) {
    it(`${s.name}: total equals the visible item count, page or no page`, async () => {
      const h = await harness({ main: RULE_SCOPE });
      const denied = await h.call(s.tool, s.input(MAIN), BASE_SCOPES);
      const granted = await h.call(s.tool, s.input(MAIN), [...BASE_SCOPES, "read:secret"]);
      const visible = (s.items as (d: any) => number)(denied.data);
      for (const t of (s.totals as (d: any) => number[])(denied.data)) expect(t).toBe(visible);
      // The scoped caller sees strictly more, so the two totals cannot be equal by accident.
      if (!s.notMore)
        expect((s.items as (d: any) => number)(granted.data)).toBeGreaterThan(visible);
    });
  }

  it("a one-item page from search_text reports no more total than the caller can read", async () => {
    const h = await harness({ main: RULE_SCOPE });
    const r = await h.call("search_text", { vault: MAIN, ...Q, limit: 1 }, BASE_SCOPES);
    expect(r.data.total).toBe(2);
    const p2 = await h.call(
      "search_text",
      { vault: MAIN, ...Q, limit: 1, cursor: r.data.next_cursor },
      BASE_SCOPES,
    );
    expect(leaks(p2.data)).toBe(false);
    expect(p2.data.next_cursor).toBeUndefined();
  });

  it("list_tags / list_properties counts exclude the hidden note", async () => {
    const h = await harness({ main: RULE_SCOPE });
    const tags = await h.call("list_tags", { vault: MAIN }, BASE_SCOPES);
    const topic = JSON.stringify(tags.data);
    expect(topic).not.toContain('"count":3');
    const withScope = await h.call("list_tags", { vault: MAIN }, [...BASE_SCOPES, "read:secret"]);
    expect(JSON.stringify(withScope.data)).toContain('"count":3');
  });
});

describe("strictReadDefault", () => {
  it("with no readPaths nothing is readable, and no surface returns a path", async () => {
    const h = await harness({ main: { strictReadDefault: true } });
    const allowed = await readNotesAllows(h, MAIN, BASE_SCOPES);
    expect(allowed.size).toBe(0);
    for (const s of SURFACES) {
      const r = await h.call(s.tool, s.input(s.vault ?? MAIN), BASE_SCOPES);
      if (r.ok) assertNoLeak(s.name, r.data, allowed, s.echoKeys);
      else expect(["acl_denied", "forbidden"]).toContain(r.error?.code);
    }
  });

  it("readPaths + a rule-scope: the scope still gates inside the whitelist", async () => {
    const h = await harness({
      main: { strictReadDefault: true, readPaths: ["pub/**", "secret/**"], ...RULE_SCOPE },
    });
    const allowed = await readNotesAllows(h, MAIN, BASE_SCOPES);
    expect([...allowed]).toEqual(["pub/a.md"]);
    for (const s of SURFACES) {
      const r = await h.call(s.tool, s.input(s.vault ?? MAIN), BASE_SCOPES);
      if (r.ok) assertNoLeak(s.name, r.data, allowed, s.echoKeys);
    }
  });
});

describe("per-vault override and cross-vault federation", () => {
  const OTHER_READ_PATHS = { readPaths: ["pub/**"] };

  it("a readPaths override on the other vault confines a direct search of it", async () => {
    const h = await harness({ main: {}, other: OTHER_READ_PATHS });
    const allowed = await readNotesAllows(h, OTHER, BASE_SCOPES);
    expect([...allowed]).toEqual(["pub/a.md"]);
    for (const s of SURFACES.filter((x) => x.vault === undefined)) {
      const r = await h.call(s.tool, s.input(OTHER), BASE_SCOPES);
      // A surface anchored on a path outside the whitelist (get_backlinks / suggest_links on
      // open/c.md) is refused outright: fail closed, which is also parity with read_notes.
      if (!r.ok) expect(r.error?.code, s.name).toBe("acl_denied");
      else assertNoLeak(`${s.name}@other`, r.data, allowed, s.echoKeys);
    }
  });

  it("vault_graph_search federated across vaults applies EACH vault's own ACL", async () => {
    const h = await harness({ main: RULE_SCOPE, other: OTHER_READ_PATHS });
    const r = await h.call(
      "vault_graph_search",
      { vault: MAIN, vaults: [OTHER], ...Q, final_top_k: 50 },
      BASE_SCOPES,
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const seen = (r.data.results as Array<{ vault?: string; path: string }>).map(
      (x) => `${x.vault ?? MAIN}:${x.path}`,
    );
    // main hides secret/ (rule-scope); other allows only pub/ (readPaths).
    expect(seen).not.toContain(`${MAIN}:${HIDDEN}`);
    expect(seen).not.toContain(`${OTHER}:${HIDDEN}`);
    expect(seen).not.toContain(`${OTHER}:open/c.md`);
    expect(seen).toContain(`${OTHER}:pub/a.md`);
    expect(seen).toContain(`${MAIN}:open/c.md`);
    expect(leaks(r.data)).toBe(false);
  });

  it("federated: the rule-scope on the OTHER vault gates it too, and the scope reopens it", async () => {
    const h = await harness({ main: {}, other: RULE_SCOPE });
    const hidden = await h.call(
      "vault_graph_search",
      { vault: MAIN, vaults: [OTHER], ...Q, final_top_k: 50 },
      BASE_SCOPES,
    );
    const seen = (hidden.data.results as Array<{ vault?: string; path: string }>).map(
      (x) => `${x.vault ?? MAIN}:${x.path}`,
    );
    expect(seen).not.toContain(`${OTHER}:${HIDDEN}`);
    expect(seen).toContain(`${MAIN}:${HIDDEN}`);
    const open = await h.call(
      "vault_graph_search",
      { vault: MAIN, vaults: [OTHER], ...Q, final_top_k: 50 },
      [...BASE_SCOPES, "read:secret"],
    );
    const seen2 = (open.data.results as Array<{ vault?: string; path: string }>).map(
      (x) => `${x.vault ?? MAIN}:${x.path}`,
    );
    expect(seen2).toContain(`${OTHER}:${HIDDEN}`);
  });

  it("a vault-bound caller cannot federate or name another vault on any search surface", async () => {
    const h = await harness({ main: RULE_SCOPE, other: {} });
    const bound = { vaultBound: true } as Partial<CallerContext>;
    const fed = await h.call(
      "vault_graph_search",
      { vault: MAIN, vaults: [OTHER], ...Q },
      BASE_SCOPES,
      bound,
    );
    expect(fed.ok).toBe(false);
    expect(fed.error?.code).toBe("forbidden");
    for (const s of SURFACES.filter((x) => x.vault === undefined)) {
      const r = await h.call(s.tool, s.input(OTHER), BASE_SCOPES, bound);
      expect(r.ok, `${s.name} on a foreign vault`).toBe(false);
      expect(r.error?.code).toBe("forbidden");
    }
    // ...and on its own vault it still gets the rule-scoped view.
    const own = await h.call("search_text", { vault: MAIN, ...Q }, BASE_SCOPES, bound);
    expect(leaks(own.data)).toBe(false);
  });
});

describe("indexing stays caller-independent", () => {
  it("index_vault run by a caller lacking a rule-scope does not drop the scoped note for one who holds it", async () => {
    const h = await harness({ main: RULE_SCOPE });
    const low = await h.call("index_vault", { vault: MAIN }, [...BASE_SCOPES, "admin:vault"]);
    expect(low.ok, JSON.stringify(low)).toBe(true);
    const r = await h.call("search_semantic", { vault: MAIN, ...Q, k: 50 }, [
      ...BASE_SCOPES,
      "read:secret",
    ]);
    expect(strings(r.data)).toContain(HIDDEN);
    const denied = await h.call("search_semantic", { vault: MAIN, ...Q, k: 50 }, BASE_SCOPES);
    expect(leaks(denied.data)).toBe(false);
  });
});
