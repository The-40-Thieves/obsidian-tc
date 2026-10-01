// retrieval.searchAutoRoute: the `auto` router's decision for a string query. Today (text-first) any
// text-leg hit, however irrelevant, stops the semantic fallback; the two candidates fuse the legs
// instead. The RED case is the shape the reader eval hit on a real vault: a note that quotes the
// query verbatim (a to-do, a candidate list) matches the literal text leg while the note that
// actually answers it shares meaning but not the phrase.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configFromVaultPath } from "../src/cli/args";
import { provisionCacheDb } from "../src/db/provision";
import { type EmbeddingProvider, fakeEmbeddingProvider } from "../src/embeddings";
import { buildServerRuntime } from "../src/runtime/server-runtime";
import { autoNeedsSemanticLeg, fuseTextAndSemantic } from "../src/search/auto-route";
import { openMemoryDb } from "./helpers";
import { makeM2Vault } from "./m2-helpers";
import { makeTempDir, rmTemp } from "./tmp";

// Bag-of-words vectors: cosine tracks shared words, so "strong semantic match" is controllable.
const DIM = 64;
const bow = (text: string): number[] => {
  const v = new Array<number>(DIM).fill(0);
  for (const tok of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of tok) h = (h * 31 + ch.charCodeAt(0)) % DIM;
    v[h] = (v[h] ?? 0) + 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};
const bowProvider: EmbeddingProvider = {
  ...fakeEmbeddingProvider({ dimensions: DIM, model: "bow" }),
  embed: (texts: string[]) => Promise.resolve(texts.map(bow)),
};

const QUERY = "glacier retreat rate";
const files = {
  // Quotes the query verbatim, otherwise unrelated: the irrelevant text hit.
  "meta.md": "# Backlog\n\ntaxes taxes taxes invoices receipts: glacier retreat rate someday\n",
  // Answers the query by meaning; the exact phrase never appears.
  "relevant.md": "# Ice\n\nmeasured rate: every glacier shows retreat\n",
  "other.md": "# Other\n\nbananas and apples in the garden\n",
};

type Out = {
  mode_used: string;
  items: Array<{ path: string; mode_used: string }>;
  _explain?: { modes_tried: string[]; chosen: string; reason: string };
};

async function search(
  autoRoute: "text-first" | "weak-text" | "hybrid" | undefined,
  input: Record<string, unknown> = { query: QUERY },
  vaultFiles: Record<string, string> = files,
  provider: EmbeddingProvider = bowProvider,
): Promise<Out> {
  const v = makeM2Vault({ files: vaultFiles, provider, ...(autoRoute ? { autoRoute } : {}) });
  try {
    await v.call("index_vault", { vault: "test" });
    const r = await v.call("search_vault", { vault: "test", explain: true, ...input });
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.data as Out;
  } finally {
    v.cleanup();
  }
}
const paths = (o: Out) => o.items.map((i) => i.path);

describe("auto router decision (pure)", () => {
  it("text-first falls back only on zero text notes", () => {
    expect(autoNeedsSemanticLeg("text-first", 0)).toBe(true);
    expect(autoNeedsSemanticLeg("text-first", 1)).toBe(false);
    expect(autoNeedsSemanticLeg("text-first", 9)).toBe(false);
  });
  it("weak-text also runs the semantic leg when exactly one note matched", () => {
    expect(autoNeedsSemanticLeg("weak-text", 0)).toBe(true);
    expect(autoNeedsSemanticLeg("weak-text", 1)).toBe(true);
    expect(autoNeedsSemanticLeg("weak-text", 2)).toBe(false);
  });
  it("hybrid always runs the semantic leg", () => {
    for (const n of [0, 1, 2, 50]) expect(autoNeedsSemanticLeg("hybrid", n)).toBe(true);
  });
});

describe("fuseTextAndSemantic (RRF over distinct notes)", () => {
  const t = (path: string, line = 1) => ({
    path,
    score: 1,
    mode_used: "text",
    snippet: `s-${path}`,
    line,
  });
  const s = (path: string, chunk: string) => ({
    path,
    score: 0.5,
    mode_used: "semantic",
    chunk_id: chunk,
  });

  it("a note in both legs outranks a note in one; ties break by path; legs dedupe by note", () => {
    const out = fuseTextAndSemantic(
      [t("a.md"), t("a.md", 7), t("b.md")],
      [s("c.md", "c1"), s("a.md", "a1"), s("c.md", "c2")],
      10,
    );
    expect(out.map((h) => h.path)).toEqual(["a.md", "c.md", "b.md"]);
    expect(out.every((h) => h.mode_used === "hybrid")).toBe(true);
    // The text leg's best line and the semantic leg's best chunk ride along for the same note.
    expect(out[0]).toMatchObject({ path: "a.md", snippet: "s-a.md", line: 1, chunk_id: "a1" });
    expect(out[1]).toMatchObject({ path: "c.md", chunk_id: "c1" });
    expect(out[1]?.snippet).toBeUndefined();
  });

  it("an empty text stream is the semantic order, deduped by note", () => {
    const out = fuseTextAndSemantic([], [s("x.md", "1"), s("y.md", "2"), s("x.md", "3")], 10);
    expect(out.map((h) => h.path)).toEqual(["x.md", "y.md"]);
  });
});

describe("search_vault auto with an irrelevant text hit (RED before the router change)", () => {
  it("text-first (today): the irrelevant note blocks the fallback, so the answer never appears", async () => {
    const o = await search("text-first");
    expect(o.mode_used).toBe("text");
    expect(paths(o)).toEqual(["meta.md"]);
    expect(o._explain?.modes_tried).toEqual(["text"]);
  });

  it("hybrid: both legs run and the answering note is returned", async () => {
    const o = await search("hybrid");
    expect(o.mode_used).toBe("hybrid");
    expect(paths(o)).toContain("relevant.md");
    expect(paths(o)).toContain("meta.md");
    expect(o._explain?.modes_tried).toEqual(["text", "semantic"]);
    expect(o._explain?.reason).toMatch(/hybrid/);
  });

  it("weak-text: a single-note text hit is fused with the semantic leg", async () => {
    const o = await search("weak-text");
    expect(o.mode_used).toBe("hybrid");
    expect(paths(o)).toContain("relevant.md");
  });

  it("weak-text: two or more matching notes keep the text answer untouched", async () => {
    const two = { ...files, "meta2.md": "# Backlog 2\n\nrevisit glacier retreat rate next year\n" };
    const o = await search("weak-text", { query: QUERY }, two);
    expect(o.mode_used).toBe("text");
    expect(paths(o).sort()).toEqual(["meta.md", "meta2.md"]);
    expect(o._explain?.modes_tried).toEqual(["text"]);
  });

  it("zero text hits: every route is the semantic fallback, identical to text-first", async () => {
    const q = { query: "ice glacier shows retreat rate measured" };
    const base = await search("text-first", q);
    expect(base.mode_used).toBe("semantic");
    for (const route of ["weak-text", "hybrid"] as const) {
      const o = await search(route, q);
      expect(o.mode_used).toBe("semantic");
      expect(o.items).toEqual(base.items);
    }
  });

  it("a failing embedding provider must not turn a text-hit answer into an error", async () => {
    const broken: EmbeddingProvider = {
      ...bowProvider,
      // Index time works; only the query-side embed fails.
      embed: (texts, o) =>
        o?.input === "query"
          ? Promise.reject(new Error("provider down"))
          : Promise.resolve(texts.map(bow)),
    };
    const o = await search("hybrid", { query: QUERY }, files, broken);
    expect(o.mode_used).toBe("text");
    expect(paths(o)).toEqual(["meta.md"]);
    // And with ZERO text hits the failure still surfaces, exactly as before.
    await expect(
      search("hybrid", { query: "nothing matches this" }, files, broken),
    ).rejects.toThrow();
  });
});

describe("flag off is byte-identical", () => {
  const CALLS: Array<Record<string, unknown>> = [
    { query: QUERY },
    { query: "ice glacier shows retreat rate measured" },
    { query: "zzzqqq" },
    { query: QUERY, explain: true },
    { query: QUERY, mode: "auto" },
    { query: QUERY, mode: "text" },
    { query: QUERY, mode: "semantic" },
    { query: "gl\\w+r", mode: "regex" },
    { query: { "==": [{ var: "path" }, "meta.md"] } },
  ];
  const run = async (autoRoute: "text-first" | undefined): Promise<string[]> => {
    const v = makeM2Vault({ files, provider: bowProvider, ...(autoRoute ? { autoRoute } : {}) });
    await v.call("index_vault", { vault: "test" });
    const out: string[] = [];
    // `meta.duration_ms` is wall-clock; everything else is compared.
    const scrub = (r: unknown) => JSON.stringify(r, (k, val) => (k === "meta" ? undefined : val));
    for (const c of CALLS) out.push(scrub(await v.call("search_vault", { vault: "test", ...c })));
    v.cleanup();
    return out;
  };

  it("the default text-first route equals an absent dependency on every call shape", async () => {
    expect(await run("text-first")).toEqual(await run(undefined));
  });

  it("the candidate routes change ONLY the string-query auto path", async () => {
    const off = await run(undefined);
    const v = makeM2Vault({ files, provider: bowProvider, autoRoute: "hybrid" });
    await v.call("index_vault", { vault: "test" });
    const scrub = (r: unknown) => JSON.stringify(r, (k, val) => (k === "meta" ? undefined : val));
    const on: string[] = [];
    for (const c of CALLS) on.push(scrub(await v.call("search_vault", { vault: "test", ...c })));
    v.cleanup();
    const changed = off.flatMap((o, i) => (o === on[i] ? [] : [i]));
    // Only the omitted-mode / explicit-auto calls with a text hit differ (indices 0, 3, 4).
    expect(changed).toEqual([0, 3, 4]);
  });
});

// The flag only matters if tool-wiring threads it: a unit test that builds registerM2Tools itself
// passes whether or not the composition root ever does.
describe("retrieval.searchAutoRoute at the composition root", () => {
  const modesTried = async (route: "text-first" | "weak-text" | "hybrid"): Promise<string[]> => {
    const vaultDir = makeTempDir("otc-sar-vault-");
    const cacheDir = makeTempDir("otc-sar-cache-");
    try {
      writeFileSync(join(vaultDir, "fox.md"), "# Fox\n\nthe quick brown fox jumps\n");
      const config = configFromVaultPath(vaultDir);
      config.cacheDir = cacheDir;
      config.retrieval.searchAutoRoute = route;
      // Nothing listens here: if the semantic leg runs it fails fast and the text answer stands.
      config.embeddings = {
        ...config.embeddings,
        provider: "openai",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "x",
        timeoutMs: 500,
      };
      const runtime = await buildServerRuntime(config, join(vaultDir, "config.json"));
      try {
        const db = openMemoryDb();
        provisionCacheDb(db);
        const ctx = {
          caller: "test",
          authenticated: true,
          grantedScopes: new Set(["*"]),
          vaultId: "main",
          db,
        };
        const r = (await runtime.registry.dispatch(
          "search_vault",
          { vault: "main", query: "fox", explain: true },
          ctx as never,
        )) as { data: { mode_used: string; _explain: { modes_tried: string[] } } };
        expect(r.data.mode_used).toBe("text");
        return r.data._explain.modes_tried;
      } finally {
        await runtime.close("test cleanup");
      }
    } finally {
      rmTemp(vaultDir);
      rmTemp(cacheDir);
    }
  };

  it("text-first (the default) never runs the semantic leg on a text hit", async () => {
    expect(await modesTried("text-first")).toEqual(["text"]);
  });

  it("weak-text and hybrid reach the router: the semantic leg is attempted", async () => {
    expect(await modesTried("hybrid")).toEqual(["text", "semantic"]);
    expect(await modesTried("weak-text")).toEqual(["text", "semantic"]);
  });
});
