/**
 * THE-618: the ACL predicate benchmark.
 *
 * The ticket asked for before/after numbers on a realistic reconcile, because there was no
 * benchmark for this path at all and "obviously faster" is not a result. This is that benchmark;
 * re-run it rather than trusting the numbers recorded in the ticket.
 *
 *   bun eval/perf/acl-bench.ts [--notes 3000] [--rules 20] [--samples 7]
 *
 * What it measures: one boot-reconcile-shaped sweep — every note path checked against the folder
 * ACL (scopesForPath, last-match-wins over every rule, no early break) and against the read
 * whitelist (readableRel). Those are the two predicates that run per note for a whole vault.
 *
 * Construction is measured separately and deliberately: precompiling moves work OUT of the per-note
 * loop and INTO the constructor, so a per-note win that is really a constructor regression would be
 * invisible if the two were reported as one number. FolderAcl is built once per vault at governance
 * boot, so a constructor cost is amortized over the whole sweep — but it must still be shown.
 */
import { performance } from "node:perf_hooks";
import { type AclConfigT, FolderAcl } from "../../src/acl";
import { readableRel } from "../../src/vault/acl-read-filter";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const NOTES = arg("notes", 3000);
const RULES = arg("rules", 20);
const SAMPLES = arg("samples", 7);

/** Folder names shaped like a real vault, including one non-ASCII segment so the NFC path is live. */
const FOLDERS = [
  "00-inbox",
  "01-daily",
  "02-projects",
  "03-health",
  "04-notes",
  "05-café",
  "06-archive",
  "07-people",
];

function buildPaths(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const f = FOLDERS[i % FOLDERS.length];
    out.push(`${f}/${f}-sub${i % 17}/note-${i}.md`);
  }
  return out;
}

function buildCfg(rules: number): AclConfigT {
  // Last-match-wins with a broad first rule, so NO rule check can be skipped and the loop always
  // runs to the end — the worst case the ticket describes, and the real shape of a deny-then-allow
  // config. Globs are distinct so each occupies its own memo entry.
  const r = [{ glob: "**", scopes: ["read:notes"] }];
  for (let i = 1; i < rules; i++) {
    r.push({ glob: `${FOLDERS[i % FOLDERS.length]}/sub${i}/**`, scopes: ["read:notes"] });
  }
  return {
    readOnly: false,
    defaultScopes: ["read:notes"],
    rules: r,
    readPaths: FOLDERS.map((f) => `${f}/**`),
    writePaths: ["02-projects/**"],
    deletePaths: [],
  };
}

function stats(xs: number[]): { mean: number; sd: number; cv: number } {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1 || 1));
  return { mean, sd, cv: mean === 0 ? 0 : sd / mean };
}

function bench(label: string, fn: () => void): void {
  for (let i = 0; i < 3; i++) fn(); // warm up JIT + the glob memo
  const runs: number[] = [];
  for (let s = 0; s < SAMPLES; s++) {
    const t0 = performance.now();
    fn();
    runs.push(performance.now() - t0);
  }
  const { mean, sd, cv } = stats(runs);
  console.log(
    `${label.padEnd(34)} ${mean.toFixed(2).padStart(9)} ms  ± ${sd.toFixed(2).padStart(6)}  (cv ${(cv * 100).toFixed(1)}%)`,
  );
}

const paths = buildPaths(NOTES);
const cfg = buildCfg(RULES);
const acl = new FolderAcl(cfg);

console.log(`THE-618 ACL bench — ${NOTES} notes x ${RULES} rules, ${SAMPLES} samples\n`);

bench("FolderAcl construction", () => {
  new FolderAcl(cfg);
});
bench("scopesForPath x notes", () => {
  for (const p of paths) acl.scopesForPath(p);
});
bench("readableRel x notes", () => {
  for (const p of paths) readableRel(acl, p);
});
bench("both (reconcile shape)", () => {
  for (const p of paths) {
    acl.scopesForPath(p);
    readableRel(acl, p);
  }
});
