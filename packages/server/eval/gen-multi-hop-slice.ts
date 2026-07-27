// THE-652 — generate a SYNTHETIC multi-hop corpus and its golden slice.
//
// THE-421 purged the original: 227 real note paths and 136 natural-language descriptions of private
// notes, published to a public repo for two weeks. That purge was correct and is not being
// reconsidered. What it cost was the ability to measure any retrieval change whose effect is
// specific to multi-hop queries — which silently blocked THE-651, THE-629 and (weakly) THE-628.
//
// ## Why generated rather than curated
//
// Constraint 1 is that this must be obviously synthetic and survive the `vault leak (structural)`
// gate BY CONSTRUCTION, not by luck. A generator satisfies that definitionally: every path, term and
// sentence here is minted from a seed, and nothing is committed except this file. Run it to produce
// the corpus + slice at a gitignored path; the seed makes that reproducible without shipping ~500
// files, and there is no curation step where real content could leak in.
//
// ## Why the topology is the whole point
//
// Constraint 2: "a flat set of synthetic notes measures nothing here." A multi-hop query is only
// multi-hop if the corpus HAS topology. So every query is built on a real 2-step chain:
//
//     seed ──links──▶ bridge ──links──▶ target        and NO seed──▶target edge
//
// A retriever that only does one hop from the seed reaches the bridge and stops; reaching the target
// requires the second step. That is the property under test, and `assertSliceInvariants` refuses to
// emit a slice where it does not hold — a generator bug that quietly emitted direct edges would make
// every downstream A/B measure nothing while looking healthy.
//
// ## Size (constraint 3: size against the MDE, before generating)
//
// `reference-obsidian-tc-eval-env` records a measured MDE of 0.037 at n=136. MDE scales ~1/sqrt(n),
// so n ≈ 136·(0.037/d)² for a target effect d:
//
//     d=0.06 → n≈52    d=0.05 → n≈75    d=0.04 → n≈117    d=0.03 → n≈207
//
// THE-448 measured UNCONDITIONAL fan-out at −0.047 nDCG@10 (p=0.0004). A conditional variant has to
// beat that by a comparable margin to be worth shipping, so d≈0.05 is the smallest effect worth
// being able to see. DEFAULT_QUERIES = 120 detects d≈0.04 — one notch below that bar, so a result
// near it is a measurement rather than a coin flip.
//
// Deliberately NOT a round number chosen first and justified later: 120 is the ceiling of the d=0.04
// requirement, and changing it should mean redoing the arithmetic above.
//
//   bun eval/gen-multi-hop-slice.ts --out <dir> [--queries 120] [--seed 652]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Detects d≈0.04 against a measured MDE of 0.037 at n=136 — see the header. */
export const DEFAULT_QUERIES = 120;
export const DEFAULT_SEED = 652;

/** Deterministic PRNG (mulberry32). Seeded so a slice is reproducible from the seed alone, which is
 *  what lets the corpus stay out of the repo without the eval becoming unrepeatable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DOMAINS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"] as const;

/** Nonsense-but-stable vocabulary. Coined words, so a "distinctive term" is genuinely rare in the
 *  corpus rather than merely uncommon in English. */
const STEMS = [
  "quorvex",
  "myndral",
  "farlibe",
  "tessoquin",
  "vandreth",
  "olimbra",
  "cresphal",
  "durnexis",
  "ilvanor",
  "pethrune",
];

export interface SliceNote {
  path: string;
  content: string;
  /** Outbound wikilinks, as note paths. */
  links: string[];
}

export interface SliceQuery {
  id: string;
  query_text: string;
  seed_domain: string;
  target_domain: string;
  seed_paths: string[];
  target_paths: string[];
  bridge_paths: string[];
}

export interface GeneratedSlice {
  notes: SliceNote[];
  queries: SliceQuery[];
}

const title = (n: string): string => n.replace(/^.*\//, "").replace(/\.md$/, "");

/**
 * Build the corpus and the slice together, so the paths in the slice are the paths that exist. A
 * golden set keyed to notes that were generated separately is the stale-copy trap in a new costume.
 */
export function generateSlice(queries = DEFAULT_QUERIES, seed = DEFAULT_SEED): GeneratedSlice {
  const rand = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

  const notes = new Map<string, SliceNote>();
  const ensure = (path: string, body: string): SliceNote => {
    const existing = notes.get(path);
    if (existing) return existing;
    const n: SliceNote = { path, content: body, links: [] };
    notes.set(path, n);
    return n;
  };

  const out: SliceQuery[] = [];
  for (let i = 0; i < queries; i++) {
    // Three DISTINCT domains, so the chain is genuinely cross-domain rather than a walk within one
    // folder that a path-prefix heuristic could shortcut.
    const shuffled = [...DOMAINS].sort(() => rand() - 0.5);
    const [sd, bd, td] = shuffled as unknown as [string, string, string];
    // FIXED-WIDTH index, and this is not cosmetic. With a variable-width suffix, "quorvex-1" is a
    // SUBSTRING of "quorvex-10", so a containment check counts one term as appearing in every note
    // whose index shares the prefix — the term stops being distinctive while still looking unique.
    // The invariant below caught exactly that (one term "appearing" in 8 notes). Padding to a
    // constant width makes prefix collision impossible.
    const term = `${pick(STEMS)}-${i.toString(36).padStart(4, "0")}`;

    const seedPath = `${sd}/Seed ${i}.md`;
    const bridgePath = `${bd}/Bridge ${i}.md`;
    const targetPath = `${td}/Target ${i}.md`;

    const s = ensure(seedPath, `# Seed ${i}\n\nThe ${term} procedure originates here.\n`);
    const b = ensure(bridgePath, `# Bridge ${i}\n\nThis note connects two unrelated areas.\n`);
    ensure(targetPath, `# Target ${i}\n\nThe ${term} procedure is applied and concluded here.\n`);

    // The chain. seed -> bridge -> target, and NEVER seed -> target: that missing edge is the
    // property the whole slice exists to measure.
    s.links.push(bridgePath);
    b.links.push(targetPath);

    out.push({
      id: `mh-${i}`,
      query_text: `How does the ${term} procedure described in ${title(seedPath)} conclude?`,
      seed_domain: sd,
      target_domain: td,
      seed_paths: [seedPath],
      target_paths: [targetPath],
      bridge_paths: [bridgePath],
    });
  }

  // Filler that raises bridge degree into the 2-20 band the original construction criteria used. A
  // bridge with degree 1 is not a bridge, it is a rename: one inbound and one outbound edge makes
  // the "hop" indistinguishable from a direct link, and expansion would find the target for free.
  const bridges = [...notes.values()].filter((n) => n.path.includes("/Bridge "));
  for (const b of bridges) {
    const extra = 1 + Math.floor(rand() * 4); // -> degree 2..5 outbound
    for (let k = 0; k < extra; k++) {
      const p = `${pick(DOMAINS)}/Filler ${b.path.replace(/\D/g, "")}-${k}.md`;
      ensure(p, `# Filler\n\nUnrelated background material.\n`);
      b.links.push(p);
    }
  }

  return { notes: [...notes.values()], queries: out };
}

export interface InvariantReport {
  noteCount: number;
  queryCount: number;
  violations: string[];
}

/**
 * The construction criteria, as assertions rather than as a comment.
 *
 * This exists because a generator bug is invisible downstream: a slice that quietly emitted direct
 * seed→target edges, or reused a "distinctive" term across many notes, would make every A/B built on
 * it measure nothing while every run looked healthy. Constraint 4 ("assert the count") is the same
 * reasoning applied to size.
 */
export function assertSliceInvariants(slice: GeneratedSlice): InvariantReport {
  const violations: string[] = [];
  const byPath = new Map(slice.notes.map((n) => [n.path, n]));

  if (slice.queries.length < 75) {
    // 75 is the d=0.05 floor from the header's arithmetic — below it the slice cannot see the
    // smallest effect worth shipping, so emitting one would be worse than emitting none.
    violations.push(`queryCount ${slice.queries.length} < 75 (MDE floor for d=0.05)`);
  }

  for (const q of slice.queries) {
    const seed = q.seed_paths[0] ? byPath.get(q.seed_paths[0]) : undefined;
    const target = q.target_paths[0];
    const bridge = q.bridge_paths[0];
    if (!seed || !target || !bridge) {
      violations.push(`${q.id}: missing seed/target/bridge`);
      continue;
    }
    // THE invariant: no direct edge, or it is not multi-hop.
    if (seed.links.includes(target)) violations.push(`${q.id}: DIRECT seed->target edge`);
    if (!seed.links.includes(bridge)) violations.push(`${q.id}: seed does not link its bridge`);
    if (!byPath.get(bridge)?.links.includes(target)) {
      violations.push(`${q.id}: bridge does not link its target`);
    }
    if (q.seed_domain === q.target_domain) violations.push(`${q.id}: seed/target share a domain`);
    // Bridge degree: 1 makes the hop indistinguishable from a direct link; >20 makes it a hub that
    // expansion reaches for free.
    const degree = byPath.get(bridge)?.links.length ?? 0;
    if (degree < 2 || degree > 20)
      violations.push(`${q.id}: bridge degree ${degree} outside 2..20`);
  }

  // Lexical distinctiveness: each query's coined term must appear in at most two notes vault-wide,
  // which is what makes the lexical arm a real signal rather than a term-frequency artifact.
  for (const q of slice.queries) {
    const term = /the (\S+) procedure/.exec(q.query_text)?.[1];
    if (!term) continue;
    const hits = slice.notes.filter((n) => n.content.includes(term)).length;
    if (hits > 2) violations.push(`${q.id}: term "${term}" appears in ${hits} notes (max 2)`);
  }

  return { noteCount: slice.notes.length, queryCount: slice.queries.length, violations };
}

/** YAML in the shape multi-hop-golden-set.example.yaml documents. Hand-rolled: the values are all
 *  generated ASCII from a fixed alphabet, so there is nothing here needing a YAML library to quote. */
export function toYaml(queries: SliceQuery[]): string {
  const lines = [
    "# THE-652 — SYNTHETIC multi-hop golden slice. Generated by eval/gen-multi-hop-slice.ts.",
    "# Every path, term and sentence is minted from a seed. Contains no real vault content by",
    "# construction — regenerate with the seed rather than editing by hand.",
    "queries:",
  ];
  for (const q of queries) {
    lines.push(`  - id: ${q.id}`);
    lines.push(`    query_text: ${JSON.stringify(q.query_text)}`);
    lines.push(`    seed_domain: ${q.seed_domain}`);
    lines.push(`    target_domain: ${q.target_domain}`);
    for (const [key, paths] of [
      ["seed_paths", q.seed_paths],
      ["target_paths", q.target_paths],
      ["bridge_paths", q.bridge_paths],
    ] as const) {
      lines.push(`    ${key}:`);
      for (const p of paths) lines.push(`      - ${JSON.stringify(p)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function main(): void {
  const arg = (name: string, fallback: string): string => {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
  };
  const outDir = arg("--out", "");
  if (!outDir) {
    process.stderr.write(
      "usage: bun eval/gen-multi-hop-slice.ts --out <dir> [--queries 120] [--seed 652]\n",
    );
    process.exit(2);
  }
  const slice = generateSlice(
    Number(arg("--queries", String(DEFAULT_QUERIES))),
    Number(arg("--seed", String(DEFAULT_SEED))),
  );
  const report = assertSliceInvariants(slice);
  if (report.violations.length > 0) {
    process.stderr.write(
      `FAIL: slice violates its own construction criteria — refusing to emit.\n${report.violations
        .slice(0, 20)
        .map((v) => `  - ${v}\n`)
        .join("")}`,
    );
    process.exit(1);
  }
  for (const n of slice.notes) {
    const abs = join(outDir, "vault", n.path);
    mkdirSync(join(abs, ".."), { recursive: true });
    const links = n.links.map((l) => `- [[${title(l)}]]`).join("\n");
    writeFileSync(abs, `${n.content}${links ? `\n## Related\n\n${links}\n` : ""}`, "utf8");
  }
  writeFileSync(join(outDir, "multi-hop-golden-set.yaml"), toYaml(slice.queries), "utf8");
  process.stderr.write(
    `wrote ${report.noteCount} notes + ${report.queryCount} queries to ${outDir}\n`,
  );
}

if ((import.meta as unknown as { main?: boolean }).main) main();
