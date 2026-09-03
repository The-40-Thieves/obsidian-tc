// THE-934 — the gate the review's own inventory found round 0 missing: the egress guard was
// installed at four CONSUMERS instead of at the PORT, so six other content-bearing call sites
// shipped excluded content unguarded (B2/B3/B4/I2/I3 in the round-0 review). This test is what
// would have caught that: it enumerates every production module that constructs a gateway client,
// an embedding provider, or a reranker, and fails when a NEW one appears outside the three guarded
// factories (gateway/client.ts's createGatewayClient, embeddings/index.ts's
// createEmbeddingProvider(Async), providers/registry.ts's resolveReranker / the raw reranker
// builders it alone is allowed to call) — the only way past it is routing through a factory (which
// guards unconditionally) or a deliberate, reviewed addition to an allowlist below.
//
// Fix round 1's version of this file proved allowlist MEMBERSHIP but not that every allowlisted
// site actually THREADS excludeFilter through — its own comment claimed the invariant while three
// entries (gaps.ts, prefetch.ts, doctor.ts) did not carry it (fix round 2, N2). Fixed by (a)
// threading excludeFilter into all three (they are query-role-only in practice, so this was inert
// but the claim is now true by construction, not by an unverified trace) and (b) this file now
// asserts every allowlisted file's source actually MENTIONS excludeFilter, not merely the factory
// call — a regression that drops the threading (while keeping the call) now fails here too.
//
// Read via a plain source scan (fs + regex), the same shape check-dev-dep-imports.mjs and this
// repo's other source-scan gates use — dependency-cruiser has no TypeScript 7 support (THE-593)
// and cannot express "every caller of this factory", but a flat grep over `packages/server/src`
// can.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
// THE-934 fix round 3 (H): the round-1/round-2 versions of this file scanned `src/` only —
// `eval/` (dev/golden-set tooling, not the shipped server, but still real vault-content-bearing
// TypeScript in this package) called createEmbeddingProvider/createGatewayClient unguarded on six
// files (densify-index.ts, run.ts, colbert_spike.ts, export-rerank-pools.ts,
// the651-ceiling-probe.ts, reembed-graph-context.ts), every one of them already reading a real
// `loadConfig(...)` — so threading `compileEgressFilter(config.egress.excludePaths)` was not a
// design decision, only an omission. All six now thread it; this scan holds that in place.
const EVAL_ROOT = fileURLToPath(new URL("../eval", import.meta.url));

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) listTsFiles(abs, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(abs);
  }
  return out;
}

/** THE-934 fix round 2 (NB1), hardened in fix round 3 (H): a comment reads exactly like a real
 *  argument once a naive `toMatch(/excludeFilter/)` scan sees it — round 2's reviewer proved this
 *  by deleting `gaps.ts`'s real `excludeFilter:` argument and leaving the sentence above it that
 *  names the field, which left the "mentions excludeFilter" test green. Round 2's fix stripped
 *  only double-slash line comments (and only a slash-star-star-prefixed block whose every
 *  continuation line happened to start with a bare star) — the round-3 reviewer proved a
 *  single-line slash-star ... star-slash block comment still satisfied it. This is a real
 *  character-scanning stripper instead: it walks the source once, drops a double-slash comment to
 *  end of line and any slash-star ... star-slash span regardless of how its continuation lines are
 *  prefixed, and is string/template-literal aware (a comment-opener sequence inside a quoted
 *  string is never mistaken for the start of a real comment). */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === "\\") {
          out += text[i];
          i++;
          if (i < n) {
            out += text[i];
            i++;
          }
          continue;
        }
        out += text[i];
        i++;
      }
      if (i < n) {
        out += text[i];
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Kept as the name the rest of this file (and its own history) already calls this by. */
function nonCommentSource(text: string): string {
  return stripComments(text);
}

/** Files matching `pattern` at a real call site — `import` statements and comment-only mentions
 *  are excluded so this does not trip on this file's own header prose, or on a type-only import.
 *  THE-934 fix round 3 (H): `root` defaults to SRC_ROOT so every existing call site is unchanged,
 *  but is now parameterized so the eval/ scan below can reuse the exact same logic instead of a
 *  second, potentially-diverging copy. */
function callSites(pattern: RegExp, root: string = SRC_ROOT): string[] {
  const hits: string[] = [];
  for (const abs of listTsFiles(root)) {
    const rel = relative(root, abs).replace(/\\/g, "/");
    const text = stripComments(readFileSync(abs, "utf8"));
    for (const line of text.split("\n")) {
      if (pattern.test(line)) {
        hits.push(rel);
        break;
      }
    }
  }
  return hits.sort();
}

// THE-934 fix round 1: every production module that calls createGatewayClient(...) directly.
// gateway/client.ts itself is the factory's OWN definition, not a call site, and is excluded.
const GATEWAY_CLIENT_ALLOWLIST = [
  "cli/commands/citation-infer.ts",
  "cli/commands/cluster.ts",
  "cli/commands/consolidate.ts",
  "cli/commands/densify-llm.ts",
  "cli/commands/index.ts",
  "providers/registry.ts",
  "runtime/tool-wiring.ts",
].sort();

// Every production module that calls createEmbeddingProvider(...) or createEmbeddingProviderAsync(...)
// directly. embeddings/index.ts is the factory's own definition (both the sync and async entry
// points), not a call site, and is excluded.
const EMBEDDING_PROVIDER_ALLOWLIST = [
  "cli/commands/citation-infer.ts",
  "cli/commands/cluster.ts",
  "cli/commands/doctor.ts",
  "cli/commands/gaps.ts",
  "cli/commands/prefetch.ts",
  "runtime/indexing-wiring.ts",
].sort();

// THE-934 fix round 3 (H): every eval/ script that calls createEmbeddingProvider or
// createGatewayClient directly — see EVAL_ROOT's comment for why these are threaded, not merely
// allowlisted with a "dev tooling" exemption.
const EVAL_EMBEDDING_PROVIDER_ALLOWLIST = [
  "colbert_spike.ts",
  "densify-index.ts",
  "export-rerank-pools.ts",
  "reembed-graph-context.ts",
  "run.ts",
  "the651-ceiling-probe.ts",
].sort();
const EVAL_GATEWAY_CLIENT_ALLOWLIST = ["the651-ceiling-probe.ts"].sort();

describe("egress port inventory (THE-934 fix round 1)", () => {
  it("finds a non-trivial number of source files — a broken scan is not a clean sweep", () => {
    expect(listTsFiles(SRC_ROOT).length).toBeGreaterThan(300);
  });

  it("createGatewayClient is called ONLY from the allowlisted composition roots", () => {
    const found = callSites(/createGatewayClient\(/).filter((f) => f !== "gateway/client.ts");
    // A file NOT in the allowlist is a NEW gateway-client construction site this test has never
    // seen — it must either route through an already-audited caller or be added here deliberately,
    // with the same excludeFilter threading every existing entry carries.
    expect(found).toEqual(GATEWAY_CLIENT_ALLOWLIST);
  });

  it("createEmbeddingProvider(Async) is called ONLY from the allowlisted composition roots", () => {
    const found = callSites(/createEmbeddingProvider(Async)?\(/).filter(
      (f) => f !== "embeddings/index.ts",
    );
    expect(found).toEqual(EMBEDDING_PROVIDER_ALLOWLIST);
  });

  // THE-934 fix round 3 (H): eval/ — not scanned at all before this round.
  it("eval/: createGatewayClient is called ONLY from the allowlisted scripts", () => {
    const found = callSites(/createGatewayClient\(/, EVAL_ROOT);
    expect(found).toEqual(EVAL_GATEWAY_CLIENT_ALLOWLIST);
  });

  it("eval/: createEmbeddingProvider(Async) is called ONLY from the allowlisted scripts", () => {
    const found = callSites(/createEmbeddingProvider(Async)?\(/, EVAL_ROOT);
    expect(found).toEqual(EVAL_EMBEDDING_PROVIDER_ALLOWLIST);
  });

  it("eval/: every allowlisted script's source actually mentions excludeFilter", () => {
    const all = new Set([...EVAL_GATEWAY_CLIENT_ALLOWLIST, ...EVAL_EMBEDDING_PROVIDER_ALLOWLIST]);
    for (const f of all) {
      const text = nonCommentSource(readFileSync(join(EVAL_ROOT, f), "utf8"));
      expect(
        text,
        `eval/${f} calls the port factory but never mentions excludeFilter outside a comment`,
      ).toMatch(/excludeFilter/);
    }
  });

  // THE-934 fix round 2 (N2), gate corrected in a follow-up (NB1): membership in the allowlist
  // above is not proof of anything — round 1's version of this file claimed every entry threads
  // excludeFilter while three did not. This asserts the WORD actually appears in each allowlisted
  // file's CODE, which is what makes "gaps.ts, prefetch.ts and doctor.ts thread it for consistency
  // even though they are query-role-only" something this gate can catch a regression on, not
  // merely something the prose claims. Round 2 scanned the raw file text, so a comment ABOVE a
  // deleted argument still satisfied it -- the follow-up review proved this by deleting gaps.ts's
  // real `excludeFilter:` argument and leaving the sentence above it that names the field, which
  // stayed green. Scanning `nonCommentSource` instead means only actual code counts.
  // THE-934 fix round 3 (H): the round-2 line-based stripper only checked whether a line's
  // TRIMMED start was "//", "*", or "/**" -- a single-line "/* excludeFilter */" block comment
  // starts with "/*" (not "/**"), so it sailed straight through as "real code" and the
  // "mentions excludeFilter" check above would have stayed green even with the real argument
  // deleted and only a block comment left in its place. Proven directly against the stripper.
  it("nonCommentSource strips a single-line block comment too, not only // lines and /**-prefixed blocks", () => {
    const src = [
      "const provider = createEmbeddingProvider(cfg.embeddings, {});",
      "/* excludeFilter: compileEgressFilter(cfg.egress.excludePaths) */",
    ].join("\n");
    expect(nonCommentSource(src)).not.toMatch(/excludeFilter/);
  });

  it("nonCommentSource never strips a comment-opener sequence that appears inside a real string literal", () => {
    const src = 'const url = "http://example.com/*not-a-comment*/still-here";';
    expect(nonCommentSource(src)).toContain("still-here");
  });

  it("every allowlisted gateway-client site's source actually mentions excludeFilter", () => {
    for (const f of GATEWAY_CLIENT_ALLOWLIST) {
      const text = nonCommentSource(readFileSync(join(SRC_ROOT, f), "utf8"));
      expect(
        text,
        `${f} calls createGatewayClient but never mentions excludeFilter outside a comment`,
      ).toMatch(/excludeFilter/);
    }
  });

  it("every allowlisted embedding-provider site's source actually mentions excludeFilter", () => {
    for (const f of EMBEDDING_PROVIDER_ALLOWLIST) {
      const text = nonCommentSource(readFileSync(join(SRC_ROOT, f), "utf8"));
      expect(
        text,
        `${f} calls createEmbeddingProvider(Async) but never mentions excludeFilter outside a comment`,
      ).toMatch(/excludeFilter/);
    }
  });

  it("THE-934 fix round 2 (Minor): no production call site passes `override` — that bypasses the port's guard entirely (embeddings/index.ts's own doc comment on `override` is the only place this invariant is stated)", () => {
    for (const f of EMBEDDING_PROVIDER_ALLOWLIST) {
      const text = nonCommentSource(readFileSync(join(SRC_ROOT, f), "utf8"));
      // Word-boundary on `override` alone (not `override:`) so this also catches
      // `..., override: fake }` spread across a line break, without tripping on an unrelated key
      // that merely ends in "override" (e.g. `template_override`).
      expect(
        text,
        `${f} passes override to createEmbeddingProvider(Async) — production must not`,
      ).not.toMatch(/\boverride\s*:/);
    }
  });

  // The guard is INSIDE createGatewayClient (gateway/client.ts's guardGatewayClient wraps the raw
  // client before it is ever returned) — so every entry above is guarded by construction, with no
  // separate "did you remember excludeFilter" step to forget. This test only has to prove no
  // SECOND way to obtain a GatewayClient exists: a hand-built object literal satisfying the
  // interface, constructed anywhere other than gateway/client.ts's own two factory functions
  // (createGatewayClient's raw client, and egress-guard.ts's guardGatewayRoles / this file's own
  // guardGatewayClient wrapper, both of which WRAP an already-guarded/injected client rather than
  // fabricate a fresh unguarded one).
  it("no production file hand-builds a GatewayClient-shaped object outside the guarded modules", () => {
    const shapeHits = callSites(/extract:\s*\(?.*=>|extract\(req\)/).filter((f) => {
      const text = readFileSync(join(SRC_ROOT, f), "utf8");
      return /synthesize/.test(text) && /judge/.test(text) && /ping/.test(text);
    });
    const allowed = new Set([
      "gateway/client.ts", // the factory itself
      "plane/egress-guard.ts", // wraps an INJECTED, already-guarded GatewayRoles
      "runtime/tool-wiring.ts", // rolesFrom() adapts an already-guarded GatewayClient
      "cli/commands/consolidate.ts", // its own local rolesFrom(), same pattern, over an
      // already-guarded createGatewayClient() result
    ]);
    const unexpected = shapeHits.filter((f) => !allowed.has(f));
    expect(unexpected).toEqual([]);
  });

  // THE-934 fix round 2 (N3): the reranker is a THIRD port — neither createGatewayClient nor
  // createEmbeddingProvider(Async) construct one. cohereCompatibleReranker (providers/http-rerank.ts)
  // and buildModelTierReranker (model/factory.ts) both build a bare 3-arg function that discards
  // `sourcePaths` structurally; nothing stopped a caller from invoking one of those RAW builders
  // directly and shipping full document text with no port backstop. The fix is the same shape as
  // the other two ports: exactly two files may call the raw builders (providers/registry.ts's
  // resolveReranker, which wraps every one of the five reranker entries with guardReranker; and
  // runtime/tool-wiring.ts's wireGatewaySeams, which wraps its own no-declared-block default
  // branch the same way) — a NEW call site outside those two, or a call site that stops pairing
  // its raw builder call with a guardReranker call, both fail here.
  const RERANKER_RAW_BUILDER_ALLOWLIST = ["providers/registry.ts", "runtime/tool-wiring.ts"].sort();

  it("the raw reranker builders (cohereCompatibleReranker, buildModelTierReranker) are called ONLY from the allowlisted composition roots", () => {
    const found = callSites(/\b(cohereCompatibleReranker|buildModelTierReranker)\(/).filter(
      (f) => f !== "providers/http-rerank.ts" && f !== "model/factory.ts",
    );
    expect(found).toEqual(RERANKER_RAW_BUILDER_ALLOWLIST);
  });

  // THE-934 fix round 4 (5): reads `nonCommentSource`, not the raw file. Round 3 hardened every
  // OTHER source-scan assertion in this file against a comment that reads like code and left this
  // one scanning raw text, so deleting the real wrap and leaving a commented-out `guardReranker(`
  // behind kept it green — the exact spoof round 2's NB1 caught one assertion away from here.
  it("every file calling a raw reranker builder also calls guardReranker — the wrap is paired, not merely present somewhere, and not merely present in a COMMENT", () => {
    for (const f of RERANKER_RAW_BUILDER_ALLOWLIST) {
      const text = nonCommentSource(readFileSync(join(SRC_ROOT, f), "utf8"));
      expect(text, `${f} builds a raw reranker but never calls guardReranker`).toMatch(
        /guardReranker\(/,
      );
    }
  });

  // THE-934 fix round 3 (E, gate for it added in H): plane-wiring.ts's `bgRoles` used to call
  // `planeRoles(deps.gatewayMaxAttempts, deps.gatewayTimeoutMs)` WITHOUT the 3rd `excludeFilter`
  // argument — planeRoles' own createGatewayClient call then defaulted to compileEgressFilter([])
  // (a no-op), so the PORT carried no real filter and the outer guardGatewayRoles wrap was the
  // ONLY thing enforcing exclusion on that client. `nonCommentSource`'s "mentions excludeFilter"
  // checks elsewhere in this file are satisfied by the word appearing ANYWHERE in a file, which
  // would have stayed green through that exact regression (excludeFilter is mentioned all over
  // plane-wiring.ts for its OTHER seams). This asserts the word is inside the planeRoles(...) call
  // ITSELF — the argument list, not merely the file.
  it("plane-wiring.ts threads excludeFilter INTO the planeRoles(...) call itself, not merely somewhere in the file", () => {
    const text = nonCommentSource(readFileSync(join(SRC_ROOT, "runtime/plane-wiring.ts"), "utf8"));
    const call = /planeRoles\(([^)]*)\)/.exec(text);
    expect(call, "runtime/plane-wiring.ts never calls planeRoles(...) at all").not.toBeNull();
    expect(
      call?.[1],
      "runtime/plane-wiring.ts's planeRoles(...) call does not pass excludeFilter as an argument",
    ).toMatch(/excludeFilter/);
  });
});
