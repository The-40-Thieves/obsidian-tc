// Golden-set contamination guard: a vault note that quotes >= N golden queries verbatim makes the
// text leg a self-reference, so the eval run must fail BEFORE scoring and name the note.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertGoldenNotInVault,
  CONTAMINATION_THRESHOLD_ENV,
  DEFAULT_CONTAMINATION_THRESHOLD,
  findGoldenContamination,
  resolveContaminationThreshold,
} from "../eval/golden-guard";
import type { GoldenSet } from "../eval/metrics";

const QUERIES = [
  "alpha cadence of the quarterly review",
  "how does the retry budget interact with backoff",
  "which folder holds the signed release manifests",
  "why was the sidecar moved behind the gateway",
  "Where do cache invalidation events get logged?",
];
const golden: GoldenSet = {
  queries: QUERIES.map((query_text, i) => ({
    id: `q-${i}`,
    query_text,
    seed_domain: "a",
    target_domain: "b",
    seed_paths: [],
    target_paths: [],
    bridge_paths: [],
    description: "fixture",
  })),
};

let root: string;
const put = (rel: string, body: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "golden-guard-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("golden-set contamination guard", () => {
  it("clean vault passes", () => {
    put("a.md", "# Notes\nnothing quoted here, only prose about releases.\n");
    put("b/c.md", `One stray quote is fine: ${QUERIES[0]}\n`);
    expect(() => assertGoldenNotInVault(golden, root, { env: {} })).not.toThrow();
  });

  it("RED: a note carrying >= 3 queries fails naming the path and count, never the query text", () => {
    put("clean.md", "no queries\n");
    put(
      "decisions/candidates.md",
      QUERIES.slice(0, 3)
        .map((q) => `- ${q}`)
        .join("\n"),
    );
    let msg = "";
    try {
      assertGoldenNotInVault(golden, root, { env: {} });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("golden-set contamination");
    expect(msg).toContain("decisions/candidates.md (3 queries)");
    expect(msg).not.toContain("clean.md");
    for (const q of QUERIES) expect(msg.toLowerCase()).not.toContain(q.toLowerCase());
  });

  it("matches like the text leg: case-insensitive, whitespace-collapsed", () => {
    put(
      "n.md",
      `${QUERIES[0]?.toUpperCase()}\n${QUERIES[1]?.replace(/ /g, "\n  ")}\n> ${QUERIES[2]}`,
    );
    expect(findGoldenContamination(golden, root, 3)).toEqual([{ path: "n.md", queries: 3 }]);
  });

  it("threshold is configurable by option and by env", () => {
    put("two.md", `${QUERIES[0]}\n${QUERIES[1]}\n`);
    expect(() => assertGoldenNotInVault(golden, root, { env: {} })).not.toThrow();
    expect(() => assertGoldenNotInVault(golden, root, { threshold: 2, env: {} })).toThrow(
      /two\.md \(2 queries\)/,
    );
    expect(() =>
      assertGoldenNotInVault(golden, root, { env: { [CONTAMINATION_THRESHOLD_ENV]: "2" } }),
    ).toThrow(/two\.md/);
  });

  it("env resolution: default, off/0 disable, garbage refused", () => {
    expect(resolveContaminationThreshold(undefined, {})).toBe(DEFAULT_CONTAMINATION_THRESHOLD);
    expect(
      resolveContaminationThreshold(undefined, { [CONTAMINATION_THRESHOLD_ENV]: "off" }),
    ).toBeNull();
    expect(
      resolveContaminationThreshold(undefined, { [CONTAMINATION_THRESHOLD_ENV]: "0" }),
    ).toBeNull();
    expect(() =>
      resolveContaminationThreshold(undefined, { [CONTAMINATION_THRESHOLD_ENV]: "many" }),
    ).toThrow(/positive integer/);
  });

  it("a disabled guard lets a contaminated vault through", () => {
    put("c.md", QUERIES.slice(0, 4).join("\n"));
    expect(() =>
      assertGoldenNotInVault(golden, root, { env: { [CONTAMINATION_THRESHOLD_ENV]: "off" } }),
    ).not.toThrow();
  });

  it("wikilinks are not quotes: a hub note linking notes titled like queries is not contamination", () => {
    put(
      "hub.md",
      QUERIES.slice(0, 4)
        .map((q) => `- [[${q}]]`)
        .join("\n"),
    );
    expect(findGoldenContamination(golden, root, 3)).toEqual([]);
  });

  it("a note on the vault's Excluded files list is not indexed, so it cannot contaminate; the same note without the exclusion does", () => {
    put("Scratch/candidates.md", QUERIES.slice(0, 3).join("\n"));
    expect(findGoldenContamination(golden, root, 3)).toEqual([
      { path: "Scratch/candidates.md", queries: 3 },
    ]);
    put(".obsidian/app.json", JSON.stringify({ userIgnoreFilters: ["Scratch/"] }));
    expect(findGoldenContamination(golden, root, 3)).toEqual([]);
    expect(() => assertGoldenNotInVault(golden, root, { env: {} })).not.toThrow();
    // A regex entry reaches it as well, and an unrelated entry does not.
    put(".obsidian/app.json", JSON.stringify({ userIgnoreFilters: ["/candidates\\.md$/"] }));
    expect(findGoldenContamination(golden, root, 3)).toEqual([]);
    put(".obsidian/app.json", JSON.stringify({ userIgnoreFilters: ["Other/"] }));
    expect(findGoldenContamination(golden, root, 3)).toHaveLength(1);
  });

  it("only the indexed tree counts: dot-folders and non-markdown files are skipped", () => {
    put(".eval-excluded/candidates.md", QUERIES.slice(0, 4).join("\n"));
    put("notes.txt", QUERIES.slice(0, 4).join("\n"));
    expect(findGoldenContamination(golden, root, 3)).toEqual([]);
  });

  it("queries under the token floor are not counted (they match prose by chance)", () => {
    const short: GoldenSet = {
      queries: ["rtk", "cache", "two words"].map((query_text, i) => ({
        ...(golden.queries[0] as GoldenSet["queries"][number]),
        id: `s-${i}`,
        query_text,
      })),
    };
    put("n.md", "rtk cache two words all appear here\n");
    expect(findGoldenContamination(short, root, 1)).toEqual([]);
  });
});

// Source-scan gate: every eval script that loads a golden set must either run the guard or be on
// the exempt list WITH a reason, so a new scoring script cannot ship unguarded. The floor keeps a
// broken scan (zero files matched) from passing as green.
describe("eval scripts are guarded", () => {
  const evalDir = join(dirname(fileURLToPath(import.meta.url)), "..", "eval");
  const EXEMPT: Record<string, string> = {
    "acl-principals.ts":
      "path arithmetic over target_paths and an ACL overlay; no vault, no retrieval",
    "history.ts": "records an existing artifact; reads the golden set only to fingerprint it",
    "score-reranked.ts": "scores pre-exported candidate pools; opens no vault",
    "embedder-arms.ts":
      "embeds golden query texts and scores pools `rerank-arms.ts pools` already guarded; opens no vault for scoring",
    "gen-fanout-variants.ts": "generates query variants; scores nothing",
    "mine-golden-candidates.ts": "mines NEW candidates from the vault; scores nothing",
    "seed-activation.ts": "activation probe over the experiential store, not a retrieval score",
    "export-enrichment-texts.ts": "exports note text for offline enrichment; scores nothing",
  };
  const scripts = readdirSync(evalDir).filter(
    (f) =>
      f.endsWith(".ts") &&
      readFileSync(join(evalDir, f), "utf8").includes("GoldenSetSchema.parse("),
  );

  it("finds the golden-loading scripts (existence floor)", () => {
    expect(scripts.length).toBeGreaterThanOrEqual(12);
  });

  it("each calls assertGoldenNotInVault or is exempt with a reason", () => {
    const unguarded = scripts.filter(
      (f) =>
        !readFileSync(join(evalDir, f), "utf8").includes("assertGoldenNotInVault(") &&
        EXEMPT[f] === undefined,
    );
    expect(unguarded).toEqual([]);
    for (const f of Object.keys(EXEMPT)) expect(scripts).toContain(f);
  });
});
