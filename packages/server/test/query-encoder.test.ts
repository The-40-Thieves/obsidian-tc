// The dense query encoder is shared by M2's search tools and M7's RetrievalRuntime. Before
// search/query-encoder.ts each built its OWN copy of the same four-line closure, privately, so
// nothing could assert the two agreed.
//
// The failure that makes this worth a module is silent: add a query prefix, a normalisation step
// or a retry to one copy and the two surfaces encode the SAME string into DIFFERENT vectors, rank
// the same query differently, and every existing suite stays green — there was no shared symbol to
// write an assertion against.
//
// So this file pins two things, because neither alone is enough:
//   1. what the encoder DOES — call shape, empty-vector degradation, and which identity it reports
//      for THE-530's stored-model filter; and
//   2. that it is the ONLY place doing it. "Someone re-added a private closure" is invisible to the
//      encoder's own behaviour, so that half is a source scan — comment-stripped and floored, since
//      a scan that reads prose or examines nothing reports success either way.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EmbeddingProvider, EmbedOptions } from "../src/embeddings/provider";
import { createQueryEncoder } from "../src/search/query-encoder";

/** Records every call so the shape reaching the provider is assertable, not assumed. */
function fakeProvider(
  vectors: number[][],
): EmbeddingProvider & { calls: Array<{ texts: string[]; opts?: EmbedOptions }> } {
  const calls: Array<{ texts: string[]; opts?: EmbedOptions }> = [];
  return {
    id: "ollama:nomic-embed-text",
    provider: "ollama",
    model: "nomic-embed-text",
    dimensions: 3,
    calls,
    async embed(texts: string[], opts?: EmbedOptions): Promise<number[][]> {
      calls.push({ texts, opts });
      return vectors;
    },
  };
}

describe("shared dense query encoder", () => {
  it("sends exactly one text, tagged as a query", async () => {
    const p = fakeProvider([[1, 2, 3]]);
    await createQueryEncoder(p).dense("how does dispatch work");

    expect(p.calls).toHaveLength(1);
    // One text, not a batch: the batch paths (cli/gaps.ts, cli/citation-infer.ts) deliberately do
    // NOT route through here — see the module header.
    expect(p.calls[0]?.texts).toEqual(["how does dispatch work"]);
    // input:"query" is what earns the provider's queryPrefix (embeddings/index.ts). Dropping it
    // would encode the query as a DOCUMENT — same dimensions, same distance metric, silently worse
    // ranking on any asymmetric model.
    expect(p.calls[0]?.opts?.input).toBe("query");
  });

  it("returns the provider's vector unchanged", async () => {
    const p = fakeProvider([[0.5, -0.25, 0]]);
    expect(await createQueryEncoder(p).dense("q")).toEqual([0.5, -0.25, 0]);
  });

  it("degrades to an empty vector rather than throwing when the provider yields none", async () => {
    // Preserved verbatim from both closures this replaces. semanticSearch and graphSearch already
    // read an empty dense vector as "no dense arm" and fall back to their other streams; throwing
    // here would turn a survivable provider hiccup into a failed tool call on a path that has
    // never failed that way. Extraction is the wrong moment to change behaviour.
    expect(await createQueryEncoder(fakeProvider([])).dense("q")).toEqual([]);
  });

  it("touches nothing on the provider at construction time", () => {
    // Tool REGISTRATION must not need a live embedder. Several suites call
    // `registerM2Tools(reg, {} as never)` to read tool metadata (names, taskAugmentable flags), and
    // that worked because the closures this module replaced only dereferenced the provider when
    // invoked. The first draft here read `storedModelId: provider.id` eagerly and broke it on all
    // four platforms with `TypeError: Cannot read properties of undefined (reading 'id')`.
    //
    // A Proxy rather than `undefined`, so this fails on ANY property access — including one added
    // later — instead of only on `.id`.
    let touched: string | undefined;
    const tripwire = new Proxy(
      {},
      {
        get(_t, prop) {
          touched = String(prop);
          return undefined;
        },
      },
    ) as EmbeddingProvider;

    expect(() => createQueryEncoder(tripwire)).not.toThrow();
    expect(touched).toBeUndefined();
    // Reading the id IS allowed to touch it — laziness, not permanent abstinence.
    createQueryEncoder(tripwire).storedModelId;
    expect(touched).toBe("id");
  });

  it("reports provider.id — NOT a representation manifest hash — as the stored-model identity", async () => {
    const p = fakeProvider([[1]]);
    // THE-530's brute-force filter compares this against chunk_embeddings.model, and the index
    // write path stores provider.id there. THE-460's representationManifestHash is the stronger
    // identity and representation.ts says so plainly, but swapping it in here without a reindex
    // would match ZERO stored rows and return an empty result set — a failure shaped exactly like
    // "this query has no hits". This assertion is what makes that swap fail loudly.
    expect(createQueryEncoder(p).storedModelId).toBe("ollama:nomic-embed-text");
    expect(createQueryEncoder(p).storedModelId).toBe(p.id);
  });
});

describe("the encoder is the only single-query dense encode in the tree", () => {
  const SRC_ROOT = fileURLToPath(new URL("../src/", import.meta.url));
  // Separators normalised to "/" for the ASSERTIONS below. readdirSync returns backslashes on
  // Windows, so the first run of this gate failed there and only there, with
  // `[ 'search\query-encoder.ts' ]` vs `[ 'search/query-encoder.ts' ]` — a green Linux run says
  // nothing about it. `posix` is what gets compared; `read` keeps the native separator, because
  // that is what readFileSync needs.
  const files = readdirSync(SRC_ROOT, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ read: SRC_ROOT + f, posix: f.replaceAll("\\", "/") }));

  // Comments stripped before scanning — this gate's own module header quotes the very call it
  // forbids, and a scan that matches its own documentation is measuring the wrong thing.
  //
  // This is a single-pass scanner, NOT the two-regex strip used elsewhere in this suite, because
  // the regex form is wrong at this scale and was caught being wrong on its first run here.
  // knowledge-tools.ts line 7 is a line comment that happens to contain a slash-star sequence (it
  // names the path "./knowledge/" with a wildcard). The non-greedy block-comment regex reads that
  // as a block opener and deletes everything through the next block terminator — 60-odd lines,
  // including every import. Over 309 files that is not an edge case worth accepting: a strip that
  // silently eats code makes "found nowhere else" meaningless in the one direction that matters.
  //
  // String literals are tracked too, so a "//" inside a URL or path is never taken for a comment.
  //
  // Written as line comments on purpose. The first draft of this very block was a JSDoc containing
  // a literal block terminator, which closed the comment early and broke the parse — the same
  // class of bug, one level up.
  const stripped = (raw: string): string => {
    let out = "";
    let i = 0;
    while (i < raw.length) {
      const c = raw[i];
      const next = raw[i + 1];
      if (c === "/" && next === "/") {
        while (i < raw.length && raw[i] !== "\n") i++;
      } else if (c === "/" && next === "*") {
        i += 2;
        while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
        i += 2;
      } else if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        out += c;
        i++;
        while (i < raw.length && raw[i] !== quote) {
          if (raw[i] === "\\") {
            out += raw[i];
            i++;
          }
          out += raw[i];
          i++;
        }
        out += quote;
        i++;
      } else {
        out += c;
        i++;
      }
    }
    return out;
  };

  // `.embed(` immediately followed by `[` is a single-query dense encode. It deliberately does not
  // match `.embed(texts,` / `.embed(queries,` / `.embed(batch)` (the batch paths, which must stay
  // direct — THE-616 made cli/gaps.ts batch-shaped precisely to kill the per-query round trip), nor
  // `.embedFull([` (the sparse/ColBERT heads, a different provider method).
  const SINGLE_QUERY_ENCODE = /\.embed\(\s*\[/;

  const hits = files
    .filter((f) => SINGLE_QUERY_ENCODE.test(stripped(readFileSync(f.read, "utf8"))))
    .map((f) => f.posix);

  it("scans a non-empty source set (floor — else every assertion below is vacuous)", () => {
    // 309 .ts files at the time of writing. A restructure that moves src/ must not turn this gate
    // into a scan of nothing that reports clean.
    expect(files.length).toBeGreaterThanOrEqual(250);
    // And the pattern must find SOMETHING, or it proves nothing about what it did not find.
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it("finds the encode in query-encoder.ts and nowhere else", () => {
    expect(hits).toEqual(["search/query-encoder.ts"]);
  });

  it("has both former copy-sites importing the shared encoder", () => {
    // The complement of the scan above: proving nobody ELSE encodes says nothing about whether M2
    // and M7 still encode at all. These two are the surfaces that used to hold private copies.
    for (const f of ["tools/m2/search-tools.ts", "tools/m7/knowledge-tools.ts"]) {
      expect(stripped(readFileSync(SRC_ROOT + f, "utf8"))).toContain("createQueryEncoder");
    }
  });

  it("strips comments without eating code", () => {
    const raw = readFileSync(`${SRC_ROOT}search/query-encoder.ts`, "utf8");
    const src = stripped(raw);
    expect(src).toContain("createQueryEncoder"); // code survived
    expect(src).not.toContain("THE-616"); // prose removed
    expect(src.length).toBeLessThan(raw.length * 0.6);
  });

  it("survives a line comment containing '/*' (the bug this stripper was written for)", () => {
    // knowledge-tools.ts line 7 reads `... a compatibility facade over ./knowledge/*. The 11 ...`.
    // A `/\/\*[\s\S]*?\*\//` strip treats that as a block opener and deletes through the next `*/`,
    // taking every import with it — which is exactly how the first draft of this gate failed. Pinned
    // as a case rather than a comment so the stripper cannot quietly regress to the regex form.
    expect(stripped("// facade over ./knowledge/*. more prose\nconst kept = 1;\n")).toContain(
      "const kept = 1;",
    );
    // And the real file, since the synthetic case above only proves the shape.
    const m7 = stripped(readFileSync(`${SRC_ROOT}tools/m7/knowledge-tools.ts`, "utf8"));
    expect(m7).toContain("createQueryEncoder");
    expect(m7).toContain("buildKnowledgeTools");
  });

  it("does not mistake a '//' inside a string literal for a comment", () => {
    expect(stripped('const u = "https://example.com/x"; const after = 2;')).toContain(
      "const after = 2;",
    );
    expect(stripped('const u = "https://example.com/x";')).toContain("https://example.com/x");
  });
});
