// THE-651 ceiling probe — a ONE-WAY FALSIFICATION TEST, not a measurement.
//
// WHY THIS EXISTS. The registered A/B for shape-conditioned decomposition cannot be decisive:
// `bridge_recall` is `0 | 1` BY TYPE (metrics.ts:50), so an effect is a count of flipped queries,
// and on the n=53 effect slice one flip is 0.0189. The registered bar (>0.031) is two flips, which
// carries a two-sided sign-test p of 0.5; reaching p<0.05 needs SIX net flips with zero
// regressions, i.e. +0.113. Running the full A/B would spend a golden-set run to produce a number
// nobody can act on.
//
// So ask the cheap question first: could decomposition rescue those queries AT ALL? The metric's
// own rule makes this answerable without any ranking model —
//
//     bridge_satisfied = query.bridge_paths.some((p) => allSet.has(p))     [metrics.ts:153]
//
// — it is pure retrieval REACHABILITY. If a gold bridge path never enters the candidate pool of
// any sub-question, no fusion, rerank or tuning can recover it, and the mechanism is dead. Passing
// proves nothing; failing kills it for a fraction of the cost.
//
// THE CONTROL THAT MATTERS, and it is not the obvious one. Sub-questions are retrieved at a DEEPER
// pool than the control's. Some bridges will surface simply because the pool got bigger —
// nothing to do with decomposition. So the probe also retrieves the ORIGINAL query at the same
// deeper K and reports the difference. A rescue is only attributable to decomposition when the
// deep original MISSES and the sub-question union HITS. Without that arm this probe would credit
// depth to decomposition, which is the same unit-mismatch trap the fan-out work already hit.
//
// The control is recomputed here rather than read from a stored artifact on purpose: the miss SET
// is only ~61% stable across the four archived control artifacts (28-30 misses each, but only 22
// in common), so a stale artifact names the wrong queries.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../src/config/load";
import { openDatabase } from "../src/db/open";
import { createEmbeddingProvider } from "../src/embeddings";
import { createGatewayClient } from "../src/gateway/client";
import { graphSearch } from "../src/search/graph_search";
import { GoldenSetSchema } from "./metrics";

/** MUST mirror `multiHopSignals()` in src/search/router.ts. That lives on the parked branch, so it
 *  is duplicated here deliberately and verified by the slice count the probe prints: the
 *  pre-registration says 53, and a drifted regex will not reproduce it. */
const MULTI_HOP_RE =
  /\b(relates? to|related to|connects? to|connection|connections|links? to|linked to|inform(?:s|ed)?|influenc\w+|underpins?|ties? into|apply to|applies to|compare[sd]?|versus|vs\.?|difference between|between|across|derives? from|leads? to|feed(?:s)? into)\b/i;

// The harness's control arm, replicated exactly. Getting this wrong is not a detail: a first cut
// of this probe fetched 10 CHUNKS and reported 33 misses where the archived control artifact has
// 16 — a strict subset, 17 queries satisfied by the harness and missed here, none the other way.
//
// Two things caused it, both documented in this repo and both easy to walk past:
//   - `TOP_K` here is 30, not 10, and `--path-dedup` fetches FANOUT_OVERFETCH_K=60 chunks and
//     dedupes to 30 unique NOTES (run.ts:456). THE-748 records that `--path-dedup` "reads as a
//     de-duplication switch and was ALSO a depth switch".
//   - `bridge_satisfied` is evaluated against `allSet` — EVERY unique path in the result list —
//     not against `top10Set` (metrics.ts:109,153). The `_at_10` metric names do not apply to it.
const CONTROL_FETCH = 60; // FANOUT_OVERFETCH_K
const CONTROL_PATHS = 30; // TOP_K, after dedupeByPath
/** The generous pool the ceiling is measured in. Deliberately 2x the control so "decomposition
 *  found it" is separable from "a bigger pool found it" — the depth-only arm below uses the same. */
const DEEP_FETCH = 120;
const DEEP_PATHS = 60;
const MAX_SUBS = 3;
/** THE-397's champion RRF constant. NOT the parked fuseRanked's k=60. */
const RRF_K = 10;

const norm = (p: string): string => p.replace(/\\/g, "/");

const SYSTEM =
  "You split a multi-hop research question into independent sub-questions that can each be " +
  "answered by retrieving from one place. Output ONLY the sub-questions, one per line, no " +
  `numbering, no prose, no preamble. Emit at most ${MAX_SUBS}. If the question is already ` +
  "single-hop, emit it unchanged as the only line.";

function parseSubQuestions(text: string, original: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const l = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
    if (l.length === 0 || l.length > 400) continue;
    const k = l.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
    if (out.length >= MAX_SUBS) break;
  }
  return out.length > 0 ? out : [original];
}

async function main(): Promise<void> {
  const [configPath, goldenPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!configPath || !goldenPath) {
    process.stderr.write(
      "usage: bun eval/the651-ceiling-probe.ts <config.json> <golden.yaml> [--cache <file.json>] [--fuse]\n",
    );
    process.exit(2);
  }
  const cacheIdx = process.argv.indexOf("--cache");
  const cachePath = cacheIdx >= 0 ? process.argv[cacheIdx + 1] : undefined;

  const config = await loadConfig(configPath);
  const vault = config.vaults[0];
  if (!vault) throw new Error("config.vaults is empty");
  const db = await openDatabase(join(config.cacheDir, "cache.db"));
  const provider = createEmbeddingProvider(config.embeddings);
  const golden = GoldenSetSchema.parse(parseYaml(readFileSync(goldenPath, "utf8")));

  // --- the slice -------------------------------------------------------------------------------
  const slice = golden.queries.filter(
    (q) => q.bridge_paths.length > 0 && MULTI_HOP_RE.test(q.query_text),
  );
  process.stdout.write(
    `slice: ${slice.length} queries (bridge-labeled AND multi-hop shaped) of ${golden.queries.length}\n`,
  );
  if (slice.length === 0) throw new Error("empty slice — the regex or the golden set is wrong");

  /** Unique note paths in rank order, deduped exactly as `dedupeByPath` + `uniquePathsInOrder` do,
   *  because that — not the raw chunk list — is what `bridge_satisfied` is evaluated against. */
  const search = async (text: string, fetchK: number, paths: number): Promise<Set<string>> => {
    const [vec] = await provider.embed([text], { input: "query" });
    const hits = await graphSearch(db, {
      query: text,
      queryVec: vec ?? [],
      vaultId: vault.id,
      finalTopK: fetchK,
    });
    const seen = new Set<string>();
    for (const h of hits) {
      seen.add(norm(h.path));
      if (seen.size === paths) break;
    }
    return seen;
  };

  // --- arm 1: the control, recomputed on THIS index --------------------------------------------
  const misses: typeof slice = [];
  for (const q of slice) {
    const paths = await search(q.query_text, CONTROL_FETCH, CONTROL_PATHS);
    if (!q.bridge_paths.some((p) => paths.has(norm(p)))) misses.push(q);
  }
  const satisfied = slice.length - misses.length;
  process.stdout.write(
    `control (fetch ${CONTROL_FETCH} -> ${CONTROL_PATHS} unique paths): ${satisfied}/${slice.length} ` +
      `bridge-satisfied; ${misses.length} MISSES — the entire addressable population\n`,
  );
  // FLOOR ON THE PROBE ITSELF. The archived controls put this slice at 37/53. A probe whose control
  // is materially weaker inflates the ceiling by counting queries the real control already gets, so
  // refuse rather than emit a number that reads as a measurement.
  const EXPECTED = 37;
  if (Math.abs(satisfied - EXPECTED) > 4) {
    process.stderr.write(
      `\nREFUSING: control reproduces ${satisfied}/${slice.length}, but the archived artifacts put ` +
        `it at ${EXPECTED}/53. The probe's retrieval does not match the harness's, so every ceiling ` +
        "below would be inflated. Fix the search options before trusting this run.\n",
    );
    process.exit(1);
  }
  process.stdout.write(`  (archived controls: ${EXPECTED}/53 — probe is within tolerance)\n\n`);
  if (misses.length === 0) {
    process.stdout.write("no misses: nothing for decomposition to rescue. KILL.\n");
    process.exit(0);
  }

  // --- decompositions, generated ONCE and cached ------------------------------------------------
  let cache: Record<string, string[]> = {};
  if (cachePath) {
    try {
      cache = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, string[]>;
      process.stdout.write(`loaded ${Object.keys(cache).length} cached decompositions\n`);
    } catch {
      /* first run */
    }
  }
  const gw = createGatewayClient({});
  const needDecomp = process.argv.includes("--fuse") ? slice : misses;
  for (const q of needDecomp) {
    if (cache[q.id]) continue;
    const res = await gw.extract({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: q.query_text },
      ],
      temperature: 0,
      maxTokens: 1200,
    });
    cache[q.id] = parseSubQuestions(res.text ?? "", q.query_text);
  }
  if (cachePath) writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);

  // --- arms 2 and 3: depth-only vs decomposition -------------------------------------------------
  let deepOnly = 0; // deeper retrieval of the ORIGINAL already finds the bridge
  let decompOnly = 0; // ONLY the sub-question union finds it -> attributable to decomposition
  let both = 0;
  let neither = 0;

  for (const q of misses) {
    const gold = q.bridge_paths.map(norm);
    const deep = await search(q.query_text, DEEP_FETCH, DEEP_PATHS);
    const deepHit = gold.some((p) => deep.has(p));

    const union = new Set<string>();
    for (const sub of cache[q.id] ?? []) {
      for (const p of await search(sub, DEEP_FETCH, DEEP_PATHS)) union.add(p);
    }
    const subHit = gold.some((p) => union.has(p));

    if (deepHit && subHit) both++;
    else if (deepHit) deepOnly++;
    else if (subHit) decompOnly++;
    else neither++;

    process.stdout.write(
      `  ${q.id.padEnd(44)} deep@${DEEP_PATHS}=${deepHit ? "HIT " : "miss"}  subq=${subHit ? "HIT " : "miss"}  subs=${(cache[q.id] ?? []).length}\n`,
    );
  }

  // --- PHASE 2 (--fuse): does the ceiling SURVIVE real fusion? ----------------------------------
  //
  // The ceiling above is an oracle: it asks only whether a gold bridge is anywhere in the union of
  // sub-question pools. The shipped arm has to RRF-merge those lists and cut back to the same 30
  // unique paths the control returns, so a bridge sitting at rank 55 of one sub-question's pool may
  // not survive. This phase runs the actual fusion and reports the two numbers the ship bar needs:
  // flips (control miss -> treatment hit) and REGRESSIONS (control hit -> treatment miss).
  //
  // Fused at RRF k=10, the champion constant (THE-397). The parked `fuseRanked` defaults to k=60,
  // which THE-397 measured as worse because it buries confident single-stream hits — running the
  // conversion check at 60 would understate the mechanism for a reason unrelated to decomposition.
  //
  // The original query's list is included, as THE-404's fusion did (run.ts:498). Dropping it would
  // discard the strongest signal and make this a different mechanism again.
  if (process.argv.includes("--fuse")) {
    process.stdout.write(
      `\n--- fusion conversion (RRF k=${RRF_K}, cut to ${CONTROL_PATHS} paths) ---\n`,
    );
    let flips = 0;
    let regressions = 0;
    let heldMiss = 0;
    let heldHit = 0;
    for (const q of slice) {
      const gold = q.bridge_paths.map(norm);
      const controlPaths = await search(q.query_text, CONTROL_FETCH, CONTROL_PATHS);
      const controlHit = gold.some((p) => controlPaths.has(p));

      // Ranked lists: the original first, then each sub-question. Fused positionally, exactly as
      // the eval's own rrfMergeLists does — score += 1/(k + rank), then take the top N paths.
      const lists: string[][] = [[...(await search(q.query_text, CONTROL_FETCH, DEEP_PATHS))]];
      for (const sub of cache[q.id] ?? []) {
        lists.push([...(await search(sub, CONTROL_FETCH, DEEP_PATHS))]);
      }
      const score = new Map<string, number>();
      for (const list of lists) {
        // Block body: `Map.set` returns the Map, and a concise arrow would hand that back to
        // forEach, which must not receive a value.
        list.forEach((path, rank) => {
          score.set(path, (score.get(path) ?? 0) + 1 / (RRF_K + rank));
        });
      }
      const fused = [...score.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, CONTROL_PATHS)
        .map(([path]) => path);
      const treatHit = gold.some((p) => fused.includes(p));

      if (!controlHit && treatHit) {
        flips++;
        process.stdout.write(`  FLIP        ${q.id}\n`);
      } else if (controlHit && !treatHit) {
        regressions++;
        process.stdout.write(`  REGRESSION  ${q.id}\n`);
      } else if (controlHit) heldHit++;
      else heldMiss++;
    }
    const net = flips - regressions;
    process.stdout.write(
      `\nflips ${flips}  regressions ${regressions}  net ${net >= 0 ? "+" : ""}${net}` +
        `   (held: ${heldHit} hit, ${heldMiss} miss)\n` +
        `net Δ bridge_recall on n=${slice.length}: ${(net / slice.length >= 0 ? "+" : "") + (net / slice.length).toFixed(4)}\n` +
        `two-sided sign-test threshold: 6 net flips (+0.1132)\n\n` +
        (net >= 6
          ? "CONVERSION SUFFICIENT — the mechanism clears the bar on this slice. Re-register properly and run the full A/B.\n"
          : `CONVERSION INSUFFICIENT — ${net} net vs 6 needed. The oracle ceiling does not survive real fusion. CLOSE THE-651.\n`),
    );
  }

  // --- verdict -----------------------------------------------------------------------------------
  const rescuable = decompOnly; // the only rescues decomposition can claim
  process.stdout.write(
    `\nof ${misses.length} misses:\n` +
      `  ${both} reachable by BOTH deeper retrieval and sub-questions\n` +
      `  ${deepOnly} reachable by DEPTH ALONE  <- decomposition gets no credit; raise finalTopK instead\n` +
      `  ${rescuable} reachable ONLY via sub-questions  <- the decomposition-attributable ceiling\n` +
      `  ${neither} unreachable either way\n\n`,
  );
  const verdict =
    rescuable < 2
      ? "KILL — cannot clear even the (too-lax) registered point bar."
      : rescuable < 6
        ? "EXPLORATORY ONLY — could clear the point bar, can never be statistically decisive at n=53."
        : "PROCEED — ceiling justifies the real A/B. Fix fuseRanked's k (60 -> 10) and count regressions among the non-misses first.";
  process.stdout.write(
    `ORACLE CEILING: ${rescuable} of ${slice.length} (${(rescuable / slice.length).toFixed(4)} mean bridge_recall)\n` +
      `6 net flips (+0.1132) is the two-sided p<0.05 threshold on this slice.\n${verdict}\n`,
  );
  db.close?.();
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
