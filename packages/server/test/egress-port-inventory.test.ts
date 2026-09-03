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

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) listTsFiles(abs, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(abs);
  }
  return out;
}

/** THE-934 fix round 2 (NB1): a comment line above a real argument reads exactly like the
 *  argument once round-2's naive `toMatch(/excludeFilter/)` scan sees it — the reviewer proved
 *  this by deleting `gaps.ts`'s real `excludeFilter:` argument and leaving the sentence above it
 *  that names the field, which left the "mentions excludeFilter" test green. Stripping comment
 *  lines first (the same `//` / `*` / `/**` check `callSites` below already applies per-line) means
 *  a mention has to be in actual code to count, whatever form it takes (a `key: value` argument, a
 *  shorthand `{ excludeFilter }`, or a bare reference) — matching only the property-colon form
 *  would instead have MISSED consolidate.ts's genuine `{ ..., excludeFilter }` shorthand site. */
function nonCommentSource(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/**"));
    })
    .join("\n");
}

/** Files matching `pattern` at a real call site — `import` statements and comment-only mentions
 *  are excluded so this does not trip on this file's own header prose, or on a type-only import. */
function callSites(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const abs of listTsFiles(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, abs).replace(/\\/g, "/");
    const text = readFileSync(abs, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/**"))
        continue;
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

  // THE-934 fix round 2 (N2), gate corrected in a follow-up (NB1): membership in the allowlist
  // above is not proof of anything — round 1's version of this file claimed every entry threads
  // excludeFilter while three did not. This asserts the WORD actually appears in each allowlisted
  // file's CODE, which is what makes "gaps.ts, prefetch.ts and doctor.ts thread it for consistency
  // even though they are query-role-only" something this gate can catch a regression on, not
  // merely something the prose claims. Round 2 scanned the raw file text, so a comment ABOVE a
  // deleted argument still satisfied it -- the follow-up review proved this by deleting gaps.ts's
  // real `excludeFilter:` argument and leaving the sentence above it that names the field, which
  // stayed green. Scanning `nonCommentSource` instead means only actual code counts.
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

  it("every file calling a raw reranker builder also calls guardReranker — the wrap is paired, not merely present somewhere", () => {
    for (const f of RERANKER_RAW_BUILDER_ALLOWLIST) {
      const text = readFileSync(join(SRC_ROOT, f), "utf8");
      expect(text, `${f} builds a raw reranker but never calls guardReranker`).toMatch(
        /guardReranker\(/,
      );
    }
  });
});
