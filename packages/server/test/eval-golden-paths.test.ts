// Golden-set label paths are normalized to forward slashes ONCE, where the set is loaded
// (`GoldenSetSchema`), so no scorer can compare an un-normalized label to an index path.
//
// The incident: the private multi-hop set labels 204 of 382 paths Windows-style
// (`09-reference\decisions\x.md`) while the index stores `09-reference/decisions/x.md`. Three scorers
// compared them raw, read every backslash label as a miss, and reported 0.40 nDCG@10 for a baseline
// that scores 0.75. This file pins the incident shape against EVERY scorer entry point, and lints
// the committed golden sets so a backslash label cannot be committed in the first place.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { generateSlice, toYaml } from "../eval/gen-multi-hop-slice";
import {
  computeQueryMetrics,
  GoldenSetSchema,
  type QueryMetrics,
  type RankedChunk,
} from "../eval/metrics";
import { restrictQuery } from "../eval/run";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evalDir = join(serverRoot, "eval");
const repoRoot = join(serverRoot, "..", "..");

const LABEL = "09-reference\\decisions\\x.md";
const RETRIEVED = "09-reference/decisions/x.md";
const INCIDENT_YAML = `queries:
  - id: incident
    query_text: "q"
    seed_domain: a
    target_domain: b
    seed_paths: ['${LABEL}']
    target_paths: ['${LABEL}']
    bridge_paths: ['${LABEL}']
    description: d
`;

const hit = (path: string): RankedChunk[] => [{ chunk_id: "c0", path }];
const load = (yaml: string) => GoldenSetSchema.parse(parseYaml(yaml));

/** Every `<kind>_paths` label in a RAW (pre-schema) golden-set document that carries a backslash. */
function backslashLabels(raw: unknown): string[] {
  const out: string[] = [];
  const queries = (raw as { queries?: Array<Record<string, unknown>> }).queries ?? [];
  for (const q of queries)
    for (const key of ["seed_paths", "target_paths", "bridge_paths"])
      for (const p of (q[key] as string[] | undefined) ?? []) if (p.includes("\\")) out.push(p);
  return out;
}

describe("the loader normalizes golden labels once", () => {
  it("rewrites Windows separators in seed, target and bridge paths", () => {
    const q = load(INCIDENT_YAML).queries[0];
    expect(q?.seed_paths).toEqual([RETRIEVED]);
    expect(q?.target_paths).toEqual([RETRIEVED]);
    expect(q?.bridge_paths).toEqual([RETRIEVED]);
  });

  it("leaves clean forward-slash labels untouched (idempotent)", () => {
    const clean = INCIDENT_YAML.replaceAll(LABEL, RETRIEVED);
    expect(load(clean).queries[0]?.target_paths).toEqual([RETRIEVED]);
  });
});

// The six scorer entry points that turn a golden set + retrieved paths into metrics. Each loads the
// set itself, so each is checked on the two things that decide the incident: it loads through the
// normalizing schema, and it does not carry its own label rewrite that a future edit could diverge.
const SCORERS = [
  "search-mode.ts",
  "query-cache.ts",
  "search-and-read-cost.ts",
  "run.ts",
  "score-reranked.ts",
  "rerank-arms.ts",
] as const;

describe.each(SCORERS)("scorer entry point %s", (file) => {
  const src = readFileSync(join(evalDir, file), "utf8");

  it("loads the golden set through the normalizing GoldenSetSchema", () => {
    expect(src).toContain("GoldenSetSchema.parse(parseYaml(");
  });

  it("does not rewrite golden labels itself", () => {
    expect(src).not.toMatch(/\b(?:seed|target|bridge)_paths\s*\.map\(\s*norm\b/);
    expect(src).not.toMatch(/\bfunction normQuery\b/);
  });

  it("scores `09-reference\\decisions\\x.md` against `09-reference/decisions/x.md` as a hit", () => {
    const q = load(INCIDENT_YAML).queries[0];
    if (!q) throw new Error("fixture has no query");
    const m = computeQueryMetrics(q, hit(RETRIEVED));
    expect(m.recall_at_10).toBe(1);
    expect(m.ndcg_at_10).toBeCloseTo(1);
    expect(m.bridge_ndcg_at_10).toBeCloseTo(1);
  });
});

describe("scorers that run without an index, end to end", () => {
  const dir = mkdtempSync(join(tmpdir(), "golden-paths-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("score-reranked.ts reads the incident labels as hits", () => {
    const golden = join(dir, "golden.yaml");
    const reranked = join(dir, "reranked.json");
    const champion = join(dir, "champion.json");
    writeFileSync(golden, INCIDENT_YAML);
    writeFileSync(
      reranked,
      JSON.stringify({
        model: "fixture",
        reranked: [{ id: "incident", order: [{ chunk_id: "c0", path: RETRIEVED }] }],
      }),
    );
    // The champion's metrics are carried through unchanged; only the reranked side is re-scored.
    const q = load(INCIDENT_YAML).queries[0];
    if (!q) throw new Error("fixture has no query");
    const perfect: QueryMetrics = computeQueryMetrics(q, hit(RETRIEVED));
    writeFileSync(champion, JSON.stringify({ perQuery: [{ id: "incident", graph: perfect }] }));
    const r = spawnSync("bun", [join(evalDir, "score-reranked.ts"), golden, reranked, champion], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    // `recall@10    <champion>  <reranked>` — the reranked column must be a full hit.
    expect(r.stdout).toMatch(/recall@10\s+1\.000\s+1\.000/);
  });

  it("run.ts restrictQuery keeps a backslash label under a forward-slash ACL glob", () => {
    const q = load(INCIDENT_YAML).queries[0];
    if (!q) throw new Error("fixture has no query");
    const r = restrictQuery(q, (rel) => rel.startsWith("09-reference/"));
    expect(r.droppedTargets).toBe(0);
    expect(r.droppedBridges).toBe(0);
  });
});

describe("committed golden sets carry no backslash labels", () => {
  const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .stdout.split("\0")
    .filter((f) => /golden[^/]*\.(?:ya?ml|json)$/i.test(f));

  it("finds the committed sets (existence floor; the private set is gitignored and never read)", () => {
    expect(tracked).toContain("packages/server/eval/multi-hop-golden-set.example.yaml");
  });

  // RAW labels, not the schema output: the schema normalizes, which would make this vacuous.
  it.each(tracked)("%s has none in its raw labels", (file) => {
    const raw = parseYaml(readFileSync(join(repoRoot, file), "utf8"));
    expect((raw as { queries: unknown[] }).queries.length).toBeGreaterThan(0);
    expect(backslashLabels(raw)).toEqual([]);
  });

  it("the generated synthetic slice has none either", () => {
    const raw = parseYaml(toYaml(generateSlice().queries));
    expect((raw as { queries: unknown[] }).queries.length).toBeGreaterThan(0);
    expect(backslashLabels(raw)).toEqual([]);
  });

  it("the lint can fail: it reports the incident shape", () => {
    expect(backslashLabels(parseYaml(INCIDENT_YAML))).toEqual([LABEL, LABEL, LABEL]);
  });
});
