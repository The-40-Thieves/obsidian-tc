// Power by SIMULATION from the empirical delta distribution — preserving its zero-inflation.
//
// The closed-form n=91 assumes a normal paired mean. The observed deltas are nothing of the sort: 58 of
// 68 multi-hop deltas are EXACTLY zero and all the mass sits in 10 movers.
//
// A first attempt at this simulation was wrong and is worth recording: it shifted the whole empirical
// distribution to the alternative mean (delta - mean + target), which turns all 58 zeros into the same
// CONSTANT positive value. A sign-flip test on a near-constant vector rejects almost always, so it
// reported 99% power at n=68 — an artifact of destroying the exact structure that makes this hard.
//
// The correct H1 keeps the MECHANISM: a query either does not move (probability 1 - rate) or it moves by
// an amount drawn from the observed movers, rescaled so the population mean equals the target. Sensitivity
// is then over the thing actually uncertain in a new corpus: how OFTEN a query moves.
import { readFileSync } from "node:fs";

const D = "E:/Projects/obsidian-tc/docs/plans/data/2026-07-14-densification";
const rd = (f: string): any => JSON.parse(readFileSync(`${D}/${f}`, "utf8"));
const A = rd("ctl.json");
const B = rd("tag.json");
const byId = new Map<string, any>(B.perQuery.map((q: any) => [q.id, q]));

const deltas: number[] = A.perQuery
  .filter((q: any) => q.id.startsWith("hop-") || q.id.startsWith("orig-"))
  .map((a: any) => byId.get(a.id).graph.ndcg_at_10 - a.graph.ndcg_at_10);

const mean = (x: number[]): number => x.reduce((s, v) => s + v, 0) / x.length;
const movers = deltas.filter((d) => Math.abs(d) > 1e-9);
const obsRate = movers.length / deltas.length;

console.log(
  `empirical multi-hop deltas: n=${deltas.length}  mean=${mean(deltas).toFixed(5)}  ` +
    `movers=${movers.length} (${(obsRate * 100).toFixed(0)}%)  zeros=${deltas.length - movers.length}`,
);
console.log(`  mover mean=${mean(movers).toFixed(4)}  (all the mass is here)\n`);

let s = 20260714;
const rnd = (): number => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const PERMS = 1000;
const SIMS = 400;
const ALPHA = 0.1;
const TARGET = 0.01; // the cost gate

function permP(x: number[]): number {
  const obs = Math.abs(mean(x));
  let ge = 0;
  for (let p = 0; p < PERMS; p++) {
    let acc = 0;
    for (const v of x) acc += rnd() < 0.5 ? v : -v;
    if (Math.abs(acc / x.length) >= obs) ge += 1;
  }
  return (ge + 1) / (PERMS + 1);
}

/**
 * H1: with probability `rate` a query moves, drawing from the observed movers scaled by `c` such that
 * rate * mean(movers) * c = TARGET. Rarer movers must therefore move HARDER to produce the same mean —
 * which is exactly the regime that costs power.
 */
function power(n: number, rate: number): number {
  const c = TARGET / (rate * mean(movers));
  let rej = 0;
  for (let i = 0; i < SIMS; i++) {
    const sample: number[] = [];
    for (let j = 0; j < n; j++) {
      sample.push(rnd() < rate ? (movers[Math.floor(rnd() * movers.length)] as number) * c : 0);
    }
    if (permP(sample) < ALPHA && mean(sample) > 0) rej += 1;
  }
  return rej / SIMS;
}

console.log(
  `simulated power (${SIMS} sims x ${PERMS} perms, alpha=${ALPHA} two-sided, true mean delta = +${TARGET})`,
);
console.log(`${"n".padStart(5)} | movers 15% (as observed) | movers 10% | movers 5%`);
for (const n of [68, 91, 120, 160, 200, 260, 340]) {
  const p1 = power(n, obsRate);
  const p2 = power(n, 0.1);
  const p3 = power(n, 0.05);
  const hit = p1 >= 0.8 ? "  <- 80% at the observed mover rate" : "";
  console.log(
    `${String(n).padStart(5)} | ${(p1 * 100).toFixed(0).padStart(23)}% | ${(p2 * 100).toFixed(0).padStart(9)}% | ${(p3 * 100).toFixed(0).padStart(8)}%${hit}`,
  );
}
