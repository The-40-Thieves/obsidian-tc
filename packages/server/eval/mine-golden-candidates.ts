// Golden-set expansion miner (THE-171 / THE-407 convention). Proposes mechanically-verified
// CANDIDATE queries from the live index for Suavecito to review — it cannot approve them, only
// mine well-formed ones. Two classes, targeting the current gaps (bridge-labeled n=41, lexical):
//
//   bridge  A-B-C where A→B and B→C edges exist, NO direct A↔C edge, bridge degree 2-20,
//           A and C in different top-folders, A–C semantically RELATED (cosine band, so the
//           multi-hop connection is meaningful not spurious), diverse across folder-pairs, and
//           neither endpoint already in the golden set. seed=[A] target=[C] bridge=[B].
//   lexical  a distinctive term appearing in ≤2 notes vault-wide (the BM25-stream class); the
//           query uses the term, target = the note(s) that contain it.
//
// query_text is a TEMPLATED DRAFT (marked) — the mechanical structure + verified relevance
// judgments are the reusable part; polish the wording on review. Output is a candidate YAML in the
// golden-set schema with per-candidate verification notes.
//
// Usage: bun eval/mine-golden-candidates.ts <config.json> <existing-golden.yaml> <out.yaml> [--bridge N] [--lexical N]
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../src/config/load";
import { openConfiguredDatabase } from "../src/db/open";
import { GoldenSetSchema } from "./metrics";

const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith("--"));
const [configPath, goldenPath, outPath] = pos;
const nBridge = argv.includes("--bridge") ? Number(argv[argv.indexOf("--bridge") + 1]) : 60;
const nLex = argv.includes("--lexical") ? Number(argv[argv.indexOf("--lexical") + 1]) : 30;
if (!configPath || !goldenPath || !outPath) {
  process.stderr.write(
    "usage: bun eval/mine-golden-candidates.ts <config.json> <existing-golden.yaml> <out.yaml> [--bridge N] [--lexical N]\n",
  );
  process.exit(2);
}

const titleOf = (p: string): string => (p.split(/[/\\]/).pop() ?? p).replace(/\.md$/i, "");
const folderOf = (p: string): string => {
  const seg = p.replace(/\\/g, "/").split("/");
  return seg.length > 1 ? (seg[0] ?? "") : "(root)";
};

// A GOOD multi-hop endpoint is a THEMATIC content note, not a navigational / operational / config
// note (those make meaningless "how does 00-THE-BRAIN relate to README" queries). Strong thematic
// folders are always in; 02-projects/09-reference/10-marketing are in only when the basename is not
// an operational artifact; root files and 00-inbox/01-daily are always out.
const STRONG = new Set([
  "04-writing",
  "05-creative",
  "06-music",
  "08-research",
  "03-health",
  "07-people",
]);
const SOFT = new Set(["02-projects", "09-reference", "10-marketing"]);
const META =
  /audit|_next|00-index|00-the-brain|00-tasks|readme|claude|coder-profile|checklist|reconciliation|handoff|-session|dashboard|_dashboard|constitution|^index$|template|inbox/i;
const isContent = (p: string): boolean => {
  const top = folderOf(p);
  if (STRONG.has(top)) return !META.test(titleOf(p));
  if (SOFT.has(top)) return !META.test(titleOf(p)) && !META.test(p.replace(/\\/g, "/"));
  return false; // root, 00-inbox, 01-daily, etc.
};
const blobToFloats = (b: Buffer): Float32Array =>
  new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));

// get-or-create a Map value without a non-null assertion (biome: noNonNullAssertion).
function getOrInit<K, V>(m: Map<K, V>, k: K, init: () => V): V {
  let v = m.get(k);
  if (v === undefined) {
    v = init();
    m.set(k, v);
  }
  return v;
}

async function main(): Promise<void> {
  const config = loadConfig(configPath as string);
  const vaultId = config.vaults[0]?.id ?? "main";
  const db = await openConfiguredDatabase(config, "cache.db");

  // Notes already used in the golden set — exclude to add NEW coverage.
  const golden = GoldenSetSchema.parse(parseYaml(readFileSync(goldenPath as string, "utf8")));
  const used = new Set<string>();
  for (const q of golden.queries)
    for (const p of [...q.seed_paths, ...q.target_paths, ...q.bridge_paths])
      used.add(p.replace(/\\/g, "/"));

  // Directed link set + out-degree.
  const edges = db
    .prepare(
      "SELECT DISTINCT source_path s, target_path t FROM vault_edges WHERE vault_id=? AND edge_type='links_to'",
    )
    .all(vaultId) as Array<{ s: string; t: string }>;
  // NUL delimiter: unambiguous for keys since vault paths never contain \u0000 (a space would be
  // ambiguous — paths contain spaces). Written as an escape so there is no literal null byte in source.
  const linked = new Set(edges.map((e) => `${e.s}\u0000${e.t}`));
  const undirected = (a: string, b: string): boolean =>
    linked.has(`${a}\u0000${b}`) || linked.has(`${b}\u0000${a}`);
  const outAdj = new Map<string, string[]>();
  const deg = new Map<string, number>();
  for (const e of edges) {
    getOrInit(outAdj, e.s, () => []).push(e.t);
    deg.set(e.s, (deg.get(e.s) ?? 0) + 1);
    deg.set(e.t, (deg.get(e.t) ?? 0) + 1);
  }

  // Note-level unit vectors (mean-pooled chunk embeddings) for the semantic-relatedness filter.
  const rows = db
    .prepare(
      "SELECT c.path p, e.embedding emb FROM chunks c JOIN chunk_embeddings e ON e.chunk_id=c.id AND e.is_active=1 WHERE c.vault_id=?",
    )
    .all(vaultId) as Array<{ p: string; emb: Buffer }>;
  const acc = new Map<string, { v: Float32Array; n: number }>();
  for (const r of rows) {
    const f = blobToFloats(r.emb);
    const cur = acc.get(r.p);
    if (!cur) acc.set(r.p, { v: Float32Array.from(f), n: 1 });
    else {
      // `?? 0` on both sides: an in-bounds TypedArray read is never undefined at runtime, but
      // noUncheckedIndexedAccess cannot know the bound, and a compound `+=` reads before it writes.
      for (let i = 0; i < cur.v.length; i++) cur.v[i] = (cur.v[i] ?? 0) + (f[i] ?? 0);
      cur.n++;
    }
  }
  const nvec = new Map<string, Float32Array>();
  for (const [p, { v, n }] of acc) {
    let s = 0;
    for (let i = 0; i < v.length; i++) {
      // Read once into a local: the original divided in place and then re-read the element to
      // square it, which is two indexed reads of a value the checker cannot prove is defined.
      const x = (v[i] ?? 0) / n;
      v[i] = x;
      s += x * x;
    }
    const norm = Math.sqrt(s) || 1;
    for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
    nvec.set(p, v);
  }
  const cos = (a: string, b: string): number => {
    const x = nvec.get(a);
    const y = nvec.get(b);
    if (!x || !y) return 0;
    let s = 0;
    for (let i = 0; i < x.length; i++) s += (x[i] ?? 0) * (y[i] ?? 0);
    return s;
  };

  // ---- bridge multi-hop mining -----------------------------------------------------------------
  type Cand = { A: string; B: string; C: string; ac: number; pair: string };
  const cands: Cand[] = [];
  for (const [B, tgts] of outAdj) {
    const d = deg.get(B) ?? 0;
    if (d < 2 || d > 20) continue; // real bridge, not a hub or a leaf
    // A links to B (someone points at B) ; B links to C
    const As = edges.filter((e) => e.t === B).map((e) => e.s);
    for (const A of As) {
      for (const C of tgts) {
        if (A === C || A === B || B === C) continue;
        if (!isContent(A) || !isContent(C)) continue; // thematic endpoints only (no nav/meta)
        if (folderOf(A) === folderOf(C)) continue; // cross-domain
        if (META.test(titleOf(B))) continue; // bridge must not be a pure nav/index note
        if (undirected(A, C)) continue; // no direct A↔C edge (true multi-hop)
        if (used.has(A) || used.has(C) || used.has(B)) continue; // new coverage
        if (!nvec.has(A) || !nvec.has(C)) continue;
        const ac = cos(A, C);
        if (ac < 0.45 || ac > 0.78) continue; // related but not near-duplicate
        const dA = deg.get(A) ?? 0;
        const dC = deg.get(C) ?? 0;
        if (dA < 2 || dC < 2) continue; // mid-degree endpoints (not orphans)
        cands.push({ A, B, C, ac, pair: `${folderOf(A)} -> ${folderOf(C)}` });
      }
    }
  }
  // Diversity: round-robin across folder-pairs, best A–C relatedness first within each.
  const byPair = new Map<string, Cand[]>();
  for (const c of cands) getOrInit(byPair, c.pair, () => []).push(c);
  for (const arr of byPair.values()) arr.sort((a, b) => b.ac - a.ac);
  const pairs = [...byPair.keys()].sort();
  const seenEndpoint = new Set<string>();
  const bridge: Cand[] = [];
  let progressed = true;
  while (bridge.length < nBridge && progressed) {
    progressed = false;
    for (const pk of pairs) {
      if (bridge.length >= nBridge) break;
      const arr = byPair.get(pk) ?? [];
      while (arr.length) {
        const c = arr.shift();
        if (!c) break;
        // one query per endpoint keeps coverage broad, not many queries on the same A/C
        if (seenEndpoint.has(c.A) || seenEndpoint.has(c.C)) continue;
        seenEndpoint.add(c.A);
        seenEndpoint.add(c.C);
        bridge.push(c);
        progressed = true;
        break;
      }
    }
  }

  // ---- lexical rare-term mining ----------------------------------------------------------------
  const contentRows = db
    .prepare("SELECT path, content FROM chunks WHERE vault_id=?")
    .all(vaultId) as Array<{ path: string; content: string }>;
  const termNotes = new Map<string, Set<string>>();
  const noise = (w: string): boolean =>
    /(.)\1\1/.test(w) || // 3+ repeated chars (aaaa)
    /^(a|the|and|for|with|that|this|from|have|about)$/.test(w);
  for (const r of contentRows) {
    if (!isContent(r.path)) continue; // only mine terms from thematic content notes
    const seen = new Set<string>();
    // strictly alphabetic word-like tokens, length 8–16, no hyphens/digits.
    for (const m of r.content.toLowerCase().matchAll(/\b[a-z]{8,16}\b/g)) {
      const w = m[0];
      if (!noise(w)) seen.add(w);
    }
    for (const w of seen) getOrInit(termNotes, w, () => new Set<string>()).add(r.path);
  }
  const lexCands: Array<{ term: string; note: string; df: number }> = [];
  for (const [term, notes] of termNotes) {
    if (notes.size < 1 || notes.size > 2) continue; // ≤2 notes vault-wide (the construction rule)
    const note = [...notes].find((n) => isContent(n) && !used.has(n.replace(/\\/g, "/")));
    if (!note) continue;
    if (titleOf(note).toLowerCase().includes(term)) continue; // not just the title token
    lexCands.push({ term, note, df: notes.size });
  }
  // diversify lexical across notes/folders (sort by note path, not term — else all land in one
  // alphabetical cluster), prefer longer = more distinctive terms per note, one term per note, cap.
  const bestPerNote = new Map<string, { term: string; note: string; df: number }>();
  for (const c of lexCands) {
    const cur = bestPerNote.get(c.note);
    if (!cur || c.term.length > cur.term.length) bestPerNote.set(c.note, c);
  }
  const lexical = [...bestPerNote.values()]
    .sort((a, b) => a.note.localeCompare(b.note))
    .filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length / nLex)) === 0) // even spread
    .slice(0, nLex);

  // ---- emit candidate YAML ---------------------------------------------------------------------
  const esc = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const yamlLines: string[] = [
    "# CANDIDATE golden-set queries — UNAPPROVED. Mined 2026-07-19 to grow n=136 toward n>=210.",
    "# THE-171: these count toward gates ONLY after Suavecito reviews + approves each one.",
    "# query_text is a TEMPLATED DRAFT — polish wording on review. The verified structure",
    "# (paths, degrees, no direct edge, term rarity) is in each description.",
    `# bridge candidates: ${bridge.length}  |  lexical candidates: ${lexical.length}`,
    "queries:",
  ];
  const bridgeTemplates = [
    (a: string, c: string) => `How does ${a} relate to ${c}?`,
    (a: string, c: string) => `What connects the ideas in ${a} and ${c}?`,
    (a: string, c: string) => `What is the relationship between ${a} and ${c}?`,
  ];
  bridge.forEach((c, i) => {
    const A = titleOf(c.A);
    const C = titleOf(c.C);
    const tmpl = bridgeTemplates[i % bridgeTemplates.length] as (a: string, c: string) => string;
    yamlLines.push(
      `  - id: cand-hop-${String(i + 1).padStart(3, "0")}`,
      `    query_text: ${esc(tmpl(A, C))}`,
      `    seed_domain: ${folderOf(c.A)}`,
      `    target_domain: ${folderOf(c.C)}`,
      `    seed_paths: [${esc(c.A.replace(/\//g, "\\"))}]`,
      `    target_paths: [${esc(c.C.replace(/\//g, "\\"))}]`,
      `    bridge_paths: [${esc(c.B.replace(/\//g, "\\"))}]`,
      `    description: ${esc(`DRAFT bridge multi-hop. A→B→C, no direct A↔C edge. bridge=${titleOf(c.B)} (degree ${deg.get(c.B)}), A–C cosine ${c.ac.toFixed(3)}. Verify the query captures a real A↔C connection.`)}`,
    );
  });
  lexical.forEach((c, i) => {
    yamlLines.push(
      `  - id: cand-lex-${String(i + 1).padStart(3, "0")}`,
      `    query_text: ${esc(`What does the vault say about "${c.term}"?`)}`,
      `    seed_domain: lexical-exact`,
      `    target_domain: lexical-exact`,
      `    seed_paths: [${esc(c.note.replace(/\//g, "\\"))}]`,
      `    target_paths: [${esc(c.note.replace(/\//g, "\\"))}]`,
      `    bridge_paths: []`,
      `    description: ${esc(`DRAFT lexical/exact-term. "${c.term}" appears in ${c.df} note(s) vault-wide. Verify the term is distinctive + the query is natural.`)}`,
    );
  });

  writeFileSync(outPath as string, `${yamlLines.join("\n")}\n`);
  process.stdout.write(
    `wrote ${outPath}: ${bridge.length} bridge + ${lexical.length} lexical = ${bridge.length + lexical.length} candidates ` +
      `(current n=${golden.queries.length} → ${golden.queries.length + bridge.length + lexical.length} if all approved)\n` +
      `bridge folder-pairs covered: ${new Set(bridge.map((c) => c.pair)).size}\n`,
  );
  db.close?.();
}

void main();
