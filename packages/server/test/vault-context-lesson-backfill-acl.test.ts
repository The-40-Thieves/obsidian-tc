import { afterAll, describe, expect, it, vi } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import type { EmbeddingProvider } from "../src/embeddings";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { floatBlob } from "../src/search/vec";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const VAULT = "main";
const GRANTED = new Set(["read:notes"]);
const QUERY_VEC = [1, 0, 0, 0];
const QUERY = "kvantorix";

function fixedVectorProvider(vec: number[]): EmbeddingProvider {
  return {
    id: "test:fixed",
    provider: "fake",
    model: "fixed",
    dimensions: vec.length,
    embed: async (texts: string[]) => texts.map(() => vec),
  } as EmbeddingProvider;
}

function addChunk(db: Database, id: string, path: string, content: string, cosine: number): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at, acl_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", content, `hash-${id}`, 1, 0, 0, path);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(
    id,
    "test:fixed",
    4,
    floatBlob([cosine, Math.sqrt(Math.max(0, 1 - cosine * cosine)), 0, 0]),
  );
}

/** filler.md dominates the engine's own top-1 (exact dense match, deterministically wins the
 *  RRF source-rank tie-break over any lexical-only candidate too) so `results` from graphSearch
 *  never contains a lesson-class chunk — the readable lesson chunk sits at cosine 0 (orthogonal),
 *  so its ONLY path into the response is the backfill loop under test. `hiddenCount` unreadable
 *  "secret/" chunks each carry the query term once (short content -> high bm25 rank); the single
 *  readable lesson chunk carries it inside much longer content (low bm25 rank) — same
 *  length-interference shape as bm25-acl-exact.test.ts's fixture. */
function buildFixture(hiddenCount: number): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  // Contains the query term too (not just a strong dense match) so it ALSO earns the RRF
  // additive lexical bonus every lexical-stream hit gets, guaranteeing it outranks "lvis" —
  // which, absent this, would win on its OWN lexical bonus despite a cosine-0 dense rank.
  addChunk(db, "filler", "public/filler.md", `${QUERY} dominant seed`, 1.0);
  const long = `${QUERY} decision text ${"filler ".repeat(40)}`;
  addChunk(db, "lvis", "09-reference/decisions/visible.md", long, 0.0);
  for (let i = 0; i < hiddenCount; i++) {
    addChunk(db, `h${i}`, `secret/hidden-${i}.md`, QUERY, 0.0);
  }
  if (!ensureChunkFts(db)) {
    throw new Error(
      "FTS5 unavailable — THE-853's assertions cannot run. Refusing to pass vacuously.",
    );
  }
  return db;
}

const RESTRICTED_ACL: AclConfigT = {
  readOnly: false,
  defaultScopes: ["read:notes"],
  rules: [],
  readPaths: ["public/**", "09-reference/**"], // denies secret/**
};

const root = makeTempDir("obtc-vc-lessons-");
afterAll(() => rmTemp(root));

function harness(db: Database) {
  const vaultRegistry = new VaultRegistry([{ id: VAULT, name: VAULT, path: root }]);
  const acl = new FolderAcl(RESTRICTED_ACL);
  const registry = new ToolRegistry({ aclResolver: () => acl });
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider: fixedVectorProvider(QUERY_VEC),
    reranker: null,
    roles: null,
    classRouter: false, // isolates this suite to the lesson-leg backfill (never lexicalRouteResults)
    acl,
  });
  const ctx: CallerContext = {
    caller: "tester",
    authenticated: true,
    grantedScopes: GRANTED,
    vaultId: VAULT,
    db,
    acl,
  };
  return { registry, ctx };
}

interface Lesson {
  chunk_id: string;
  path: string;
  via: "engine" | "lexical";
}

async function lessonsFor(db: Database): Promise<Lesson[]> {
  const { registry, ctx } = harness(db);
  const res = await registry.dispatch(
    "vault_context",
    { vault: VAULT, query: QUERY, k: 1, token_budget: 4000 },
    ctx,
  );
  expect(res.ok).toBe(true);
  if (!res.ok) return [];
  const data = res.data as { notes: unknown[]; lessons: Lesson[] };
  // Non-vacuous per-call guard: the engine's own top-K (k=1) really did go to the filler, not a
  // lesson chunk — otherwise "no lesson via engine" would be assumed rather than proven.
  expect(data.notes).not.toContainEqual(
    expect.objectContaining({ path: expect.stringContaining("decisions") }),
  );
  return data.lessons;
}

describe("THE-853 vault_context lesson-leg backfill threads aclSetId into bm25Chunks", () => {
  // No "documents the defect" case here (unlike router-lexical-route-acl.test.ts): this suite
  // dispatches the REAL tool end-to-end, and the tool always resolves and threads its own
  // aclSetId now — there is no caller-controlled way to invoke it "without the fix" short of
  // reverting the source. That revert-and-rerun (all THREE tests below fail against the pre-fix
  // vault-context.ts/router.ts) is the watched-failure step for this file; see the task report.
  it("finds the readable lesson regardless of hidden volume once the fix threads aclSetId", async () => {
    const lessons = await lessonsFor(buildFixture(850));
    expect(lessons.map((l) => l.chunk_id)).toContain("lvis");
    const hit = lessons.find((l) => l.chunk_id === "lvis");
    expect(hit?.via).toBe("lexical");
    expect(hit?.path).toBe("09-reference/decisions/visible.md");
    // Never an unreadable path anywhere in the lesson list.
    for (const l of lessons) expect(l.path.startsWith("secret/")).toBe(false);
  });

  it("non-interference: unaffected by hidden volume — 850 hidden and 2000 hidden agree", async () => {
    const few = (await lessonsFor(buildFixture(850))).map((l) => l.chunk_id).sort();
    const many = (await lessonsFor(buildFixture(2000))).map((l) => l.chunk_id).sort();
    expect(many).toStrictEqual(few);
    expect(many).toContain("lvis");
  });

  it("FAIL-CLOSED: restricted caller + acl_path_sets substrate absent -> backfill skipped, not leaky", async () => {
    const db = buildFixture(3); // low hidden volume: the leaky fallback WOULD normally succeed here
    db.exec("DROP TABLE acl_path_members");
    db.exec("DROP TABLE acl_path_sets");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lessons = await lessonsFor(db);
    warn.mockRestore();
    // The backfill guard (`!walkFilter.aclWalkFilter?.blocked`) skips the leg entirely rather than
    // running bm25Chunks through the leaky fallback. At hidden=3 (well under the 850-row over-fetch
    // window), an unguarded fallback call would trivially find "lvis" — so its absence here is the
    // fail-closed behavior kicking in, not a fixture artifact of too much hidden volume.
    expect(lessons.map((l) => l.chunk_id)).not.toContain("lvis");
    expect(lessons).toEqual([]);
  });
});
