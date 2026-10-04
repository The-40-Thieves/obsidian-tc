// The public multi-shape suite (eval/corpora): registry <-> files, corpus statistics, the digest
// pin, planned power, golden-set mining, and the committed golden sets. Offline: tiny fixtures under
// a temp dir; the real corpora are checked by the fetch/--check commands, not here.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { computeCorpusStats } from "../eval/corpora/corpus-stats";
import {
  archiveUrl,
  digestDirectory,
  loadRegistry,
  type RemoteCorpus,
  verifyDirectory,
} from "../eval/corpora/fetch-corpus";
import { GOLDEN_CLASSES, mineGolden, recipeOf, serialize } from "../eval/corpora/gen-corpus-golden";
import { HEADLINE_SIGMA_D, plannedPower } from "../eval/corpora/suite-plan";
import { DEFAULT_QUERIES, DEFAULT_SEED, generateSlice, toYaml } from "../eval/gen-multi-hop-slice";
import { assertGoldenNotInVault } from "../eval/golden-guard";
import { GoldenSetSchema } from "../eval/metrics";

const CORPORA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "eval", "corpora");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eval-corpora-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(rel: string, text: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

describe("corpora registry", () => {
  const registry = loadRegistry();
  const names = Object.keys(registry.corpora);

  it("lists the three suite corpora", () => {
    expect(names.sort()).toEqual(["knowledge-garden", "quartz-docs", "synthetic-multihop"]);
  });

  it("pins every remote corpus to a full commit and a well-formed digest", () => {
    for (const [name, spec] of Object.entries(registry.corpora)) {
      if (spec.kind !== "github") continue;
      expect(spec.commit, name).toMatch(/^[0-9a-f]{40}$/);
      expect(spec.digest.sha256, name).toMatch(/^[0-9a-f]{64}$/);
      expect(spec.digest.files, name).toBeGreaterThan(0);
      expect(spec.digest.bytes, name).toBeGreaterThan(0);
      expect(archiveUrl(spec), name).toContain(spec.commit);
    }
  });

  it("points every attribution anchor at a heading in ATTRIBUTION.md", () => {
    const attribution = readFileSync(join(CORPORA_DIR, "ATTRIBUTION.md"), "utf8");
    for (const [name, spec] of Object.entries(registry.corpora)) {
      expect(spec.attribution, name).toBe(`ATTRIBUTION.md#${name}`);
      expect(attribution, name).toMatch(new RegExp(`^## ${name}$`, "m"));
    }
    expect(attribution).toContain("Copyright (c) 2021 jackyzha0");
    expect(attribution).toContain("Copyright (c) 2022 oldwinter");
  });

  it("has a README naming every corpus", () => {
    const readme = readFileSync(join(CORPORA_DIR, "README.md"), "utf8");
    for (const name of names) expect(readme, name).toContain(`\`${name}\``);
  });
});

describe("archiveUrl", () => {
  const spec = (commit: string): RemoteCorpus => ({
    ...(loadRegistry().corpora["quartz-docs"] as RemoteCorpus),
    commit,
  });

  it("refuses a branch, a tag and a short sha", () => {
    for (const bad of ["main", "v4.0.0", "97a2d05", "97A2D05F80C4C50534959B1D0D41CC4B3895625E"]) {
      expect(() => archiveUrl(spec(bad))).toThrow(/full commit sha/);
    }
  });
});

describe("digest pin", () => {
  it("is stable for the same files and throws naming the field that moved", () => {
    put("a.md", "# A\n");
    put("sub/b.md", "# B\n");
    put(".hidden/c.md", "skipped\n");
    put("notes.txt", "not markdown\n");
    const d = digestDirectory(root);
    expect(d.files).toBe(2);
    expect(d.bytes).toBe(8);
    expect(verifyDirectory(root, d)).toEqual(d);
    put("sub/b.md", "# B changed\n");
    expect(() => verifyDirectory(root, d)).toThrow(/bytes: expected 8.*sha256: expected/s);
  });
});

describe("computeCorpusStats", () => {
  it("counts resolved links, the unresolved share, orphans and CJK share", () => {
    put("a.md", "---\ntitle: a\n---\nSee [[b]] and [[nowhere]] and [site](https://example.com).\n");
    put("dir/b.md", "Back to [[a]].\n");
    put("c.md", "A lonely note.\n");
    put("zh.md", "这是一个中文笔记。\n");
    const s = computeCorpusStats(root);
    expect(s.notes).toBe(4);
    expect(s.resolvedLinks).toBe(2);
    expect(s.linkOccurrences).toBe(4);
    expect(s.unresolvedShare).toBe(0.5);
    expect(s.orphanRate).toBe(0.5);
    expect(s.noInboundRate).toBe(0.5);
    expect(s.folderDepth.max).toBe(1);
    expect(s.cjkShare).toBeGreaterThan(0.05);
    expect(s.cjkShare).toBeLessThan(0.5);
  });
});

describe("plannedPower", () => {
  it("reproduces the preregistered MDEs through powerReport", () => {
    expect(plannedPower(78, HEADLINE_SIGMA_D).mde).toBeCloseTo(0.0653, 3);
    expect(plannedPower(120, HEADLINE_SIGMA_D).mde).toBeCloseTo(0.053, 3);
    expect(plannedPower(220, HEADLINE_SIGMA_D).mde).toBeCloseTo(0.039, 3);
  });

  it("builds a vector with exactly the requested sample spread, odd and even n", () => {
    for (const n of [77, 78, 119, 120])
      expect(plannedPower(n, 0.206).sigmaD).toBeCloseTo(0.206, 10);
  });

  it("refuses n below 2", () => {
    expect(() => plannedPower(1, 0.2)).toThrow();
  });
});

describe("mineGolden", () => {
  const FILLER = "the quarterly cadence of the review board remains steady throughout the year";
  function fixture(): void {
    for (let i = 0; i < 12; i++) {
      const next = (i + 1) % 12;
      put(
        `topic/note-${i}.md`,
        `# Note ${i}\n\n## Unique heading number ${i} here\n\n${FILLER} ${i}. A distinctive sentence about subject${i} appears only once in note ${i}. See [[note-${next}]] for the follow up discussion of subject${next}.\n`,
      );
    }
  }
  const recipe = {
    seed: 7,
    idPrefix: "t",
    template: "en" as const,
    caps: {
      "link-context": 3,
      "bridge-2hop": 2,
      "quote-fragment": 3,
      "unique-heading": 3,
      "exact-title": 3,
    },
  };

  it("is deterministic, schema-valid, guard-clean and within its caps", () => {
    fixture();
    const a = mineGolden(root, recipe);
    expect(serialize(mineGolden(root, recipe))).toBe(serialize(a));
    expect(a.length).toBeGreaterThan(0);
    const parsed = GoldenSetSchema.parse(JSON.parse(serialize(a)));
    expect(() => assertGoldenNotInVault(parsed, root)).not.toThrow();
    for (const cls of GOLDEN_CLASSES) {
      const n = a.filter((q) => q.categories?.includes(cls)).length;
      expect(n, cls).toBeLessThanOrEqual(recipe.caps[cls]);
    }
    expect(new Set(a.map((q) => q.id)).size).toBe(a.length);
  });

  it("changes with the seed", () => {
    fixture();
    expect(serialize(mineGolden(root, { ...recipe, seed: 8 }))).not.toBe(
      serialize(mineGolden(root, recipe)),
    );
  });

  it("refuses a recipe with a missing class cap", () => {
    expect(() => recipeOf("synthetic-multihop")).toThrow(/no golden recipe/);
  });
});

describe("committed golden sets", () => {
  const registry = loadRegistry();

  it("parse with GoldenSetSchema and match the registry's per-class caps", () => {
    for (const name of ["quartz-docs", "knowledge-garden"]) {
      const spec = registry.corpora[name] as RemoteCorpus;
      const golden = GoldenSetSchema.parse(
        JSON.parse(readFileSync(join(CORPORA_DIR, "golden", `${name}.json`), "utf8")),
      );
      const caps = spec.golden?.caps ?? {};
      let total = 0;
      for (const cls of GOLDEN_CLASSES) {
        const n = golden.queries.filter((q) => q.categories?.includes(cls)).length;
        expect(n, `${name} ${cls}`).toBe(caps[cls]);
        total += n;
      }
      expect(golden.queries.length, name).toBe(total);
      expect(new Set(golden.queries.map((q) => q.id)).size, name).toBe(golden.queries.length);
    }
  });

  it("includes a synthetic set that regenerates byte for byte from its seed", () => {
    const committed = readFileSync(join(CORPORA_DIR, "golden", "synthetic-multihop.yaml"), "utf8");
    const spec = registry.corpora["synthetic-multihop"];
    expect(spec?.kind).toBe("generated");
    if (spec?.kind !== "generated") return;
    expect(spec.seed).toBe(DEFAULT_SEED);
    expect(spec.queries).toBe(DEFAULT_QUERIES);
    expect(toYaml(generateSlice(spec.queries, spec.seed).queries)).toBe(committed);
    expect(GoldenSetSchema.parse(parseYaml(committed)).queries).toHaveLength(spec.queries);
  });

  it("carries the plan the smoke run was preregistered against", () => {
    const plan = JSON.parse(readFileSync(join(CORPORA_DIR, "suite-plan.json"), "utf8"));
    const byName = Object.fromEntries(
      plan.entries.map((e: { name: string; golden: { n: number } }) => [e.name, e.golden.n]),
    );
    expect(byName).toMatchObject({
      evergreen: 78,
      "quartz-docs": 120,
      "knowledge-garden": 220,
      "synthetic-multihop": 120,
    });
  });
});
