// THE-934 — the egress predicate every plane boundary calls before a chunk's text reaches the
// gateway or the embedding provider. Pins: basic glob matching (same engine as readPaths),
// unicode folder names, and (fix round 3, F) the literal-pattern folder-widening normalization
// compileEgressFilter applies -- without it, `["Private"]` or `["Private/"]` (the most natural
// config an operator would write) compiled to an exact-string match that excluded nothing real.
//
// A prior version of this file also had a "renamed folder is re-evaluated" test that compared
// TWO DIFFERENT path strings against the SAME compiled filter across two separate calls -- it
// exercised neither memoization (this module's own header says it deliberately has none against
// the path) nor any actual rename I/O, so it proved only that isExcludedPath is a pure function of
// its two arguments, already implied by every other test here. Removed per fix round 3 (H)'s
// "test the claim it documents or delete it" instruction.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { createEmbeddingProvider } from "../src/embeddings";
import type { FetchFn } from "../src/embeddings/http";
import {
  assertSourcePathsAllowed,
  compileEgressFilter,
  EgressViolationError,
  hasExcludePatterns,
  isExcludedPath,
} from "../src/plane/egress-filter";

describe("egress filter (THE-934)", () => {
  it("matches a vault-relative path against a **-glob", () => {
    const filter = compileEgressFilter(["Private/**"]);
    expect(isExcludedPath(filter, "Private/journal.md")).toBe(true);
    expect(isExcludedPath(filter, "Private/nested/deep.md")).toBe(true);
    expect(isExcludedPath(filter, "Public/journal.md")).toBe(false);
  });

  it("empty exclude list excludes nothing", () => {
    const filter = compileEgressFilter([]);
    expect(isExcludedPath(filter, "anything.md")).toBe(false);
  });

  it("multiple globs: a match on ANY pattern excludes", () => {
    const filter = compileEgressFilter(["A/**", "B/**"]);
    expect(isExcludedPath(filter, "A/x.md")).toBe(true);
    expect(isExcludedPath(filter, "B/x.md")).toBe(true);
    expect(isExcludedPath(filter, "C/x.md")).toBe(false);
  });

  // Reporter's own fixture shape (THE-934 ticket provenance): a hard output firewall over two
  // personal folders with non-ASCII names.
  it("matches unicode folder names (NFC-normalized, per acl.ts's THE-272 handling)", () => {
    const filter = compileEgressFilter(["🧠 Private/**", "日記/**"]);
    expect(isExcludedPath(filter, "🧠 Private/thoughts.md")).toBe(true);
    expect(isExcludedPath(filter, "日記/2026-09-02.md")).toBe(true);
    expect(isExcludedPath(filter, "Public/日記-mentions.md")).toBe(false);
  });

  // THE-934 fix round 3 (F): globToRegExp (acl.ts) compiles a literal pattern to an EXACT match
  // only -- "Private" -> ^Private$, "Private/" -> ^Private/$ -- neither matches
  // "Private/journal.md". compileEgressFilter now widens every literal pattern to also match
  // everything nested under it as a folder, so the bare-folder-name config an operator would
  // naturally write actually excludes something.
  describe("literal-pattern folder widening (fix round 3, F)", () => {
    it("a bare folder name with no trailing slash excludes everything under it", () => {
      const filter = compileEgressFilter(["Private"]);
      expect(isExcludedPath(filter, "Private/journal.md")).toBe(true);
      expect(isExcludedPath(filter, "Private/nested/deep.md")).toBe(true);
      expect(isExcludedPath(filter, "Public/journal.md")).toBe(false);
    });

    it("a folder name WITH a trailing slash behaves identically", () => {
      const filter = compileEgressFilter(["Private/"]);
      expect(isExcludedPath(filter, "Private/journal.md")).toBe(true);
      expect(isExcludedPath(filter, "Private/nested/deep.md")).toBe(true);
      expect(isExcludedPath(filter, "Public/journal.md")).toBe(false);
    });

    it("an explicit Private/** glob (already had metacharacters) is untouched and behaves the same", () => {
      const filter = compileEgressFilter(["Private/**"]);
      expect(isExcludedPath(filter, "Private/journal.md")).toBe(true);
      expect(isExcludedPath(filter, "Private/nested/deep.md")).toBe(true);
      expect(isExcludedPath(filter, "Public/journal.md")).toBe(false);
    });

    it("a literal FILE pattern still matches only that exact file — a sibling with a longer name does NOT match", () => {
      const filter = compileEgressFilter(["Private/a.md"]);
      expect(isExcludedPath(filter, "Private/a.md")).toBe(true);
      // "Private/a.md.bak" is not nested UNDER "Private/a.md/" as a folder — the widening only
      // ever adds a "/**" suffix, never a bare substring match.
      expect(isExcludedPath(filter, "Private/a.md.bak")).toBe(false);
      expect(isExcludedPath(filter, "Private/b.md")).toBe(false);
    });

    it("all three folder-shaped spellings (Private, Private/, Private/**) exclude the identical set", () => {
      const paths = ["Private/journal.md", "Private/nested/deep.md", "Public/x.md", "Private"];
      const bare = compileEgressFilter(["Private"]);
      const slash = compileEgressFilter(["Private/"]);
      const glob = compileEgressFilter(["Private/**"]);
      for (const p of paths) {
        const b = isExcludedPath(bare, p);
        expect(isExcludedPath(slash, p)).toBe(b);
        // Private/** alone does not match the bare "Private" path itself (no trailing content),
        // but DOES agree with the other two on every path that actually has something after it —
        // asserted separately since that is the one path in this list where they differ by design
        // (Private/** requires the ** to consume at least the rest of the string after the /).
        if (p !== "Private") expect(isExcludedPath(glob, p)).toBe(b);
      }
    });
  });
});

// THE-934 fix round 4 (1) — the round-3 widening closed two SPELLINGS of the fail-open, not the
// class. `/Private`, `./Private`, `**/Private`, `Private//`, `Private*/`, `*/Private/` and
// `Private/*` all still compiled to a pattern that matched nothing under the folder, and two of
// them (`/Private`, `**/Private`) are ordinary gitignore that the `.describe()` invites an
// operator to write. This table is the CLASS: one expectation set, asserted against both consumers
// that can act on it -- the reconcile-side predicate (`isExcludedPath`, what
// IndexVaultArgs.isEgressExcluded wraps) and the PORT (a provider built through the real
// `createEmbeddingProvider`, whose guard is the last line of defence). They cannot disagree,
// because a disagreement is exactly the round-0 defect this ticket exists to close.
const PATHS = [
  "Private/journal.md",
  "Nested/Private/journal.md",
  "Private.md",
  "Privateer.md",
] as const;

/** pattern -> which of PATHS it must exclude, in the same order. */
const NORMALISATION_TABLE: ReadonlyArray<readonly [string, readonly boolean[], string]> = [
  ["Private", [true, false, false, false], "a bare folder name is root-anchored (round 3)"],
  ["Private/", [true, false, false, false], "a trailing slash changes nothing (round 3)"],
  ["Private/**", [true, false, false, false], "the explicit glob, unchanged"],
  ["/Private", [true, false, false, false], "a leading slash is stripped — gitignore root anchor"],
  ["./Private", [true, false, false, false], "a leading ./ is stripped the same way"],
  ["Private//", [true, false, false, false], "repeated separators collapse"],
  [
    "**/Private",
    [true, true, false, false],
    "matches a Private folder at ANY depth, root included, and its subtree",
  ],
  [
    "Private*/",
    [true, false, true, true],
    // Over-exclusion, stated rather than glossed: widening a folder-shaped pattern also matches a
    // FILE of that name, so `Private*` catches Private.md and Privateer.md at the root. That is the
    // SAFE direction for an egress control (excluding a public note costs recall; missing a private
    // one leaks) and it is the same trade round 3 already made for `Private/`, which likewise
    // matches a file named exactly `Private`.
    "a metacharacter folder pattern widens too — and over-matches root files of that shape",
  ],
  [
    "*/Private/",
    [false, true, false, false],
    "one level deep exactly: Nested/Private/... matches, a root Private/ does not",
  ],
  [
    "Private/*",
    [true, false, false, false],
    "direct children AND deeper — gitignore never descends into an excluded directory either",
  ],
];

describe("pattern normalisation, the whole class (THE-934 fix round 4, 1)", () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as FetchFn;

  for (const [pattern, expected, why] of NORMALISATION_TABLE) {
    it(`${pattern} — ${why}`, async () => {
      const filter = compileEgressFilter([pattern]);
      const provider = createEmbeddingProvider(
        { provider: "ollama", model: "nomic-embed-text", dimensions: 2 },
        { fetchFn, excludeFilter: filter },
      );
      for (const [i, path] of PATHS.entries()) {
        const want = expected[i] as boolean;
        // 1. the reconcile-side predicate
        expect(isExcludedPath(filter, path), `isExcludedPath(${pattern}, ${path})`).toBe(want);
        // 2. the one predicate every port guard calls
        const assertion = () => assertSourcePathsAllowed(filter, "embed", [path]);
        if (want) expect(assertion).toThrow(EgressViolationError);
        else expect(assertion).not.toThrow();
        // 3. the real port, end to end — a declaration naming this path is refused iff excluded
        const call = provider.embed(["text"], { input: "document", sourcePaths: [path] });
        if (want) await expect(call).rejects.toBeInstanceOf(EgressViolationError);
        else await expect(call).resolves.toBeDefined();
      }
    });
  }

  it("Private/* covers the whole subtree, not only direct children", () => {
    const filter = compileEgressFilter(["Private/*"]);
    expect(isExcludedPath(filter, "Private/journal.md")).toBe(true);
    expect(isExcludedPath(filter, "Private/deep/nested/x.md")).toBe(true);
  });

  it("a literal FILE pattern is untouched by the widening — no sibling is swept in", () => {
    const filter = compileEgressFilter(["Private/a.md"]);
    expect(isExcludedPath(filter, "Private/a.md")).toBe(true);
    expect(isExcludedPath(filter, "Private/a.md.bak")).toBe(false);
    expect(isExcludedPath(filter, "Private/journal.md")).toBe(false);
  });
});

// THE-934 fix round 4 (1) — ONE degenerate spelling is REFUSED, not compiled: a pattern that
// normalises to nothing (`""`, and its leading-slash-only or whitespace-only variants), which sits
// in a config looking like a configured exclusion while protecting nothing. It must fail at CONFIG
// LOAD, and the schema's refine and the compiler must agree on the set — a compiler that throws on
// a pattern the schema accepts turns a typo into a boot crash, and the reverse leaves the compiler
// unreachable. `**` is deliberately NOT in that set; see the exclude-all describe below.
const parseConfigWith = (excludePaths: string[]) =>
  ServerConfigSchema.safeParse({
    vaults: [{ id: "v", path: "/tmp/vault" }],
    egress: { excludePaths },
  });

describe("unusable patterns are refused at config load AND by the compiler (THE-934 fix round 4, 1)", () => {
  const UNUSABLE = ["", " ", "   ", "/", "./", "//"];
  const USABLE = [
    "Private",
    "Private/",
    "Private/**",
    "/Private",
    "**/Private",
    "*",
    "Private/*",
    "**",
    "**/",
  ];

  for (const pattern of UNUSABLE) {
    it(`${JSON.stringify(pattern)} is refused by both the schema and compileEgressFilter`, () => {
      expect(parseConfigWith([pattern]).success).toBe(false);
      expect(() => compileEgressFilter([pattern])).toThrow(/unusable pattern/);
    });
  }

  for (const pattern of USABLE) {
    it(`${JSON.stringify(pattern)} is accepted by both`, () => {
      expect(parseConfigWith([pattern]).success).toBe(true);
      expect(() => compileEgressFilter([pattern])).not.toThrow();
    });
  }

  it("the refusal names the offending pattern, so an operator can find it in their config", () => {
    expect(() => compileEgressFilter(["Private/**", ""])).toThrow(/""/);
  });
});

// THE-934 fix round 4 (1), corrected — `["**"]` is the EXCLUDE-ALL form and must stay VALID: it
// withholds every note from every hosted provider, which is a legitimate fully-local deployment
// (the plane still runs; nothing vault-derived leaves the machine through it). An earlier version
// of this round refused it and pointed the operator at `plane.enabled: false`, which is a
// DIFFERENT setting — it turns the consolidation jobs off entirely rather than keeping them local
// — and which would have turned a previously valid config into a boot failure on upgrade.
describe('"**" is the exclude-all form, valid and total (THE-934 fix round 4, 1)', () => {
  const ALL_PATHS = [
    "Private/journal.md",
    "Public/a.md",
    "root.md",
    "deeply/nested/note.md",
  ] as const;

  it("loads through the real config schema", () => {
    const parsed = parseConfigWith(["**"]);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.egress.excludePaths).toEqual(["**"]);
  });

  it("excludes a private AND a public note alike, at reconcile and at the port", async () => {
    const filter = compileEgressFilter(["**"]);
    const fetchFn = (async () =>
      new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as FetchFn;
    const provider = createEmbeddingProvider(
      { provider: "ollama", model: "nomic-embed-text", dimensions: 2 },
      { fetchFn, excludeFilter: filter },
    );
    for (const path of ALL_PATHS) {
      // 1. the reconcile-side predicate (IndexVaultArgs.isEgressExcluded wraps this)
      expect(isExcludedPath(filter, path), `isExcludedPath(**, ${path})`).toBe(true);
      // 2. the one predicate every port guard calls
      expect(() => assertSourcePathsAllowed(filter, "embed", [path])).toThrow(EgressViolationError);
      // 3. the real port, end to end
      await expect(
        provider.embed(["text"], { input: "document", sourcePaths: [path] }),
      ).rejects.toBeInstanceOf(EgressViolationError);
    }
  });

  it('"**/" is the same filter, so a trailing separator changes nothing', () => {
    expect(compileEgressFilter(["**/"]).patterns).toEqual(compileEgressFilter(["**"]).patterns);
  });

  it("a request that declares NO vault paths still passes — exclude-all withholds content, it does not break the plane", async () => {
    const filter = compileEgressFilter(["**"]);
    const fetchFn = (async () =>
      new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as FetchFn;
    const provider = createEmbeddingProvider(
      { provider: "ollama", model: "nomic-embed-text", dimensions: 2 },
      { fetchFn, excludeFilter: filter },
    );
    // `[]` is a real declaration ("this request carries no vault content") and is unaffected by
    // how wide the filter is — the query leg and the episode-summary leg both rely on it.
    await expect(
      provider.embed(["text"], { input: "document", sourcePaths: [] }),
    ).resolves.toBeDefined();
  });
});

// THE-934 fix round 4 (4) — `compileEgressFilter([])` is a real filter that excludes nothing, and
// every production wiring builds one unconditionally. Consumers that FAIL CLOSED on unprovable
// provenance must be able to tell "no filter threaded" from "a filter with no patterns"; see
// advisory-sweep.test.ts for the behaviour that depends on it.
describe("hasExcludePatterns (THE-934 fix round 4, 4)", () => {
  it("is false for an empty configuration and true once anything is configured", () => {
    expect(hasExcludePatterns(compileEgressFilter([]))).toBe(false);
    expect(hasExcludePatterns(compileEgressFilter(["Private"]))).toBe(true);
  });
});
