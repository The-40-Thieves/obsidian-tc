// reranker.passageFormat: what text a reranker is handed per candidate. Proves (1) "chunk" is the
// historical raw text and is the default everywhere, (2) "title+chunk" is exactly the
// `<title>\n\n<chunk>` passage the reranker eval measured, (3) the setting reaches the reranker from
// every call site (gated rerank, rrf_rerank, score_merge) and from config via M7's
// vault_graph_search, and (4) it does not widen what egress.excludePaths lets out.
import { afterAll, describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { compileEgressFilter } from "../src/plane/egress-filter";
import { graphSearch } from "../src/search/graph_search";
import {
  formatRerankPassage,
  type Reranker,
  type RerankPassageFormat,
  rerankWithScores,
} from "../src/search/rerank";
import { floatBlob } from "../src/search/vec";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const VAULT = "v1";

/** The formula the reranker eval harness used inline before it was moved into the product. Kept
 *  here verbatim as the oracle: the shipped passage must equal what was measured. */
const evalHarnessPassage = (path: string, text: string): string =>
  `${(path.split("/").pop() ?? path).replace(/\.md$/i, "")}\n\n${text}`;

function spy(): { reranker: Reranker; seen: string[][] } {
  const seen: string[][] = [];
  const reranker: Reranker = async (_q, documents) => {
    seen.push([...documents]);
    return documents.map((_d, index) => ({ index, relevanceScore: 1 - index * 0.1 }));
  };
  return { reranker, seen };
}

describe("formatRerankPassage", () => {
  it('"chunk" returns the raw chunk text untouched', () => {
    expect(formatRerankPassage({ content: "body", path: "Notes/Title.md" }, "chunk")).toBe("body");
  });

  it('"title+chunk" is the title, a blank line, then the chunk', () => {
    expect(formatRerankPassage({ content: "body", path: "Notes/Title.md" }, "title+chunk")).toBe(
      "Title\n\nbody",
    );
  });

  it.each([
    ["Top.md", "a"],
    ["Folder/Sub/Deep Note.md", "multi\nline\n\nchunk"],
    ["Folder/Upper.MD", "x"],
    ["Folder/no-extension", "x"],
    ["Notes/Dots.in.name.md", "x"],
    ["Notes/Ünïcode ノート.md", "x"],
    ["Notes/Title.md.md", "x"],
  ])("equals the eval harness's measured passage for %s", (path, text) => {
    expect(formatRerankPassage({ content: text, path }, "title+chunk")).toBe(
      evalHarnessPassage(path, text),
    );
  });

  it("never prefixes a cluster_summary row, whose path is a cluster key and not a note", () => {
    expect(
      formatRerankPassage(
        { content: "summary", path: "cluster/auth-and-sessions", source: "cluster_summary" },
        "title+chunk",
      ),
    ).toBe("summary");
    // ...while a note-level summary row has a real path and is prefixed like any chunk.
    expect(
      formatRerankPassage(
        { content: "summary", path: "Notes/Title.md", source: "summary" },
        "title+chunk",
      ),
    ).toBe("Title\n\nsummary");
  });
});

describe("rerankWithScores passageFormat", () => {
  const docs = [
    { content: "alpha", path: "Notes/A Note.md" },
    { content: "beta", path: "Notes/B Note.md" },
  ];

  it("sends raw chunks by default and when 'chunk' is named", async () => {
    const a = spy();
    await rerankWithScores("q", docs, 2, a.reranker);
    const b = spy();
    await rerankWithScores("q", docs, 2, b.reranker, undefined, undefined, undefined, "chunk");
    expect(a.seen).toEqual([["alpha", "beta"]]);
    expect(b.seen).toEqual([["alpha", "beta"]]);
  });

  it("sends title-prefixed passages for 'title+chunk', and returns the ORIGINAL items", async () => {
    const s = spy();
    const out = await rerankWithScores(
      "q",
      docs,
      2,
      s.reranker,
      undefined,
      undefined,
      undefined,
      "title+chunk",
    );
    expect(s.seen).toEqual([["A Note\n\nalpha", "B Note\n\nbeta"]]);
    // The prefix is a scoring input only: the caller gets its own candidate objects back.
    expect(out.map((o) => o.item.content)).toEqual(["alpha", "beta"]);
  });

  it("an excluded path is never sent, in either format (the title is not a way around the filter)", async () => {
    const mixed = [
      { content: "PRIVATE BODY", path: "Private/Secret Title.md" },
      { content: "public body", path: "Public/Open Title.md" },
    ];
    for (const format of ["chunk", "title+chunk"] as RerankPassageFormat[]) {
      const s = spy();
      await rerankWithScores(
        "q",
        mixed,
        2,
        s.reranker,
        undefined,
        undefined,
        compileEgressFilter(["Private/**"]),
        format,
      );
      const sent = s.seen.flat().join("\n");
      expect(sent).not.toContain("PRIVATE BODY");
      expect(sent).not.toContain("Secret Title");
    }
  });
});

// --- graphSearch: every rerankWithScores call site threads the option -------------------------

function vd(c: number): number[] {
  return [c, Math.sqrt(1 - c * c), 0, 0];
}

function addChunk(
  db: ReturnType<typeof openMemoryDb>,
  id: string,
  path: string,
  content: string,
  vec: number[],
): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at, acl_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", content, `h-${id}`, 1, 0, 0, path);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:embed", vec.length, floatBlob(vec));
}

function hardDb() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  addChunk(db, "a", "Notes/Alpha Title.md", "alpha content", vd(0.4)); // top-1 0.4 < 0.55: hard
  addChunk(db, "b", "Notes/Beta Title.md", "beta content", vd(0.35));
  addChunk(db, "c", "Notes/Gamma Title.md", "gamma content", vd(0.3));
  return db;
}

const BASE = {
  query: "anything at all",
  queryVec: [1, 0, 0, 0],
  model: "test:embed",
  vaultId: VAULT,
  finalTopK: 10,
  seedCount: 3,
  router: { enabled: false as const },
  lexical: { enabled: false as const },
};

const TITLED = [
  "Alpha Title\n\nalpha content",
  "Beta Title\n\nbeta content",
  "Gamma Title\n\ngamma content",
];
const RAW = ["alpha content", "beta content", "gamma content"];

describe("graphSearch threads rerankPassageFormat to every rerank call site", () => {
  it.each([
    ["gatedRerank", { gatedRerank: { enabled: true } }],
    ["rrf_rerank", { fusionMode: "rrf_rerank" as const }],
    ["score_merge", { fusionMode: "score_merge" as const }],
  ])("%s: 'title+chunk' reaches the reranker, absent means raw", async (_name, mode) => {
    const titled = spy();
    await graphSearch(hardDb(), {
      ...BASE,
      ...mode,
      reranker: titled.reranker,
      rerankPassageFormat: "title+chunk",
    });
    expect(titled.seen).toHaveLength(1);
    expect([...(titled.seen[0] ?? [])].sort()).toEqual([...TITLED].sort());

    const raw = spy();
    await graphSearch(hardDb(), { ...BASE, ...mode, reranker: raw.reranker });
    expect(raw.seen).toHaveLength(1);
    expect([...(raw.seen[0] ?? [])].sort()).toEqual([...RAW].sort());
  });
});

// --- config -> M7 vault_graph_search ----------------------------------------------------------

const root = makeTempDir("obtc-rerank-passage-format-");
afterAll(() => rmTemp(root));

async function searchWith(rerankPassageFormat?: RerankPassageFormat): Promise<string[]> {
  const db = hardDb();
  const s = spy();
  const registry = new ToolRegistry({});
  registerM7Tools(registry, {
    vaultRegistry: new VaultRegistry([{ id: VAULT, name: VAULT, path: root }]),
    embeddingProvider: {
      id: "test:embed",
      provider: "ollama",
      model: "stub",
      dimensions: 4,
      embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]),
    } as any,
    reranker: s.reranker,
    roles: null,
    retrieval: { gatedRerank: true },
    ...(rerankPassageFormat ? { rerankPassageFormat } : {}),
  });
  await registry.dispatch(
    "vault_graph_search",
    { vault: VAULT, query: "anything at all" },
    {
      caller: "tester",
      authenticated: true,
      grantedScopes: new Set(["read:notes"]),
      vaultId: VAULT,
      db,
    },
  );
  expect(s.seen).toHaveLength(1);
  return [...(s.seen[0] ?? [])].sort();
}

describe("M7 wiring: deps.rerankPassageFormat reaches the reranker through vault_graph_search", () => {
  it("title+chunk sends titled passages", async () => {
    expect(await searchWith("title+chunk")).toEqual([...TITLED].sort());
  });

  it("unset and 'chunk' both send raw chunks (the default is unchanged)", async () => {
    expect(await searchWith()).toEqual([...RAW].sort());
    expect(await searchWith("chunk")).toEqual([...RAW].sort());
  });
});
