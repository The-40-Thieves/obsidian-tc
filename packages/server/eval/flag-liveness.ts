// THE-807: an eval flag must not be able to no-op in silence.
//
// THE DEFECT THIS EXISTS TO PREVENT. `run.ts` writes its `--json` artifact flag list from the flags
// the caller *passed*, never from what the run *did*. Three flags reached an external dependency,
// fell back to the plain path when it was absent, and still stamped themselves into the artifact:
// `--decompose` (a deleted Ollama backend), `--sparse` (a provider with no `embedFull`) and
// `--gated-rerank` (no `RERANK_URL`). Each produced a clean, well-formed, statistically valid null
// measuring the control against itself.
//
// WHY THE EXISTING GUARD CANNOT CATCH IT. The same-unit guard compares the two arms' recorded flag
// SETS and fires when they match. Here they legitimately differ — the control carries no marker and
// the variant carries one — so it passes while the results are byte-identical. A flag that lies
// about itself is invisible to a check that reads the flag.
//
// THE SHAPE OF THE FIX IS NOT NEW. `run.ts` already refuses three times for exactly this reason:
// `--fanout` throws at zero coverage ("This would have run as a no-op and reported 'no effect'"),
// `--max-per-cluster` throws on an unclustered index ("Fail loudly instead"), and `--acl-allow`
// throws when the whitelist leaves too few queries ("a number that reads as a measurement and is
// not one"). This module applies that convention to the three flags that missed it, in one place,
// so the next dependency-bearing flag inherits it rather than re-deriving it.
//
// Liveness is resolved against the ALREADY-CONSTRUCTED run context wherever possible — the actual
// provider object, the actual reranker — rather than by probing a URL. That checks the same
// condition the run itself branches on, so the preflight cannot disagree with the code it guards.

/** The run-time objects a liveness check may interrogate. Structural on purpose: this module must
 *  not import the eval's concrete provider/reranker types, or the test that imports it drags
 *  `eval/` (which is outside `tsconfig.json`'s `include`) into the typecheck graph. */
export interface FlagLivenessContext {
  /** The embedding provider actually handed to `runEval`. `embedFull` is optional on
   *  `EmbeddingProvider` and implemented by `bgeM3Provider` alone. */
  provider: { embedFull?: unknown };
  /** The reranker actually handed to `runEval`, or null when `RERANK_URL` is unset. NOTE: presence
   *  is NOT liveness here — see the `gated-rerank` check, which calls it. */
  reranker:
    | ((
        query: string,
        documents: string[],
        topN: number,
        sourcePaths: string[],
      ) => Promise<unknown[]>)
    | null;
  /** Resolved decomposition backend (DECOMPOSE_URL, else the Ollama default). */
  decomposeUrl: string;
  /** The model the decomposer will ask for. A reachable daemon that lacks this model fails on
   *  /api/chat, which `decomposeQuery` swallows. */
  decomposeModel: string;
  /** How many chunks actually carry cached activation state. Zero means the lookup returns null for
   *  every chunk, i.e. the inert multiplier on every candidate. */
  activationRows: number;
  /** Injectable for the test; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export interface LivenessResult {
  live: boolean;
  /** Names the missing dependency. Goes straight into the operator-facing refusal, so it must say
   *  WHICH backend is absent — a generic "not configured" is what made this class invisible. */
  detail: string;
}

export interface FlagDependency {
  /** The flag as the operator types it. */
  cli: string;
  check: (ctx: FlagLivenessContext) => Promise<LivenessResult>;
}

const PROBE_TIMEOUT_MS = 3_000;

/** The decomposer's defaults, declared ONCE. They were briefly written twice — once where the run
 *  calls the decomposer and once in the preflight — which would let the check validate a different
 *  backend or model than the run actually asks for, and a preflight that disagrees with the code it
 *  guards is worse than none. */
export const DEFAULT_DECOMPOSE_URL = "http://127.0.0.1:11434";
export const DEFAULT_DECOMPOSE_MODEL = "llama3.2:3b";

/** Flags whose realized behavior depends on something outside this process, checked here.
 *  Keyed by the token they contribute to the `--json` artifact flag list (the template-literal
 *  entries contribute their prefix), which is what ties this registry to the gate. */
export const DEPENDENCY_GATED_FLAGS: Record<string, FlagDependency> = {
  sparse: {
    cli: "--sparse",
    // The run branches on `opts.provider.embedFull` being callable, so that is the condition to
    // check. Note the asymmetry this closes: SPARSE_URL *set* with the server down already throws
    // from the fetch, loudly and correctly. The silent case is SPARSE_URL *unset*, which leaves the
    // config provider in place — and on this vault's champion backbone (nomic) that provider has no
    // `embedFull`, so the sparse stream never fuses and the artifact says it did.
    check: async (ctx) => ({
      live: typeof ctx.provider.embedFull === "function",
      detail:
        "the configured embedding provider does not implement embedFull(), so no learned-sparse " +
        "query weights can be produced and the run would score the plain dense path. Set " +
        "SPARSE_URL to a bge-m3 token_classify server, or use a bge-m3 provider.",
    }),
  },
  "gated-rerank": {
    cli: "--gated-rerank",
    // PRESENCE IS NOT LIVENESS, and getting that wrong here would have reproduced the very bug this
    // module exists to stop. `run.ts` builds the reranker closure from RERANK_URL alone, so a
    // non-null reranker proves only that an env var was set. If the endpoint is unreachable or
    // malformed, `rerankWithScores` catches it (rerank.ts: `provider_error` -> `fallback()`) and
    // returns the INPUT ORDER — a scoreable `gated-rerank` arm in which nothing was reranked.
    //
    // So the check calls the reranker. Invoking the real closure exercises the whole path the run
    // will take, including response parsing, which a bare URL ping does not: a backend that answers
    // 200 with an unparseable body is just as inert as one that is down.
    check: async (ctx) => {
      if (!ctx.reranker) {
        return {
          live: false,
          detail:
            "no reranker is configured, so the gated-rerank stage would report not_configured and " +
            "pass results through unchanged on BOTH arms. Set RERANK_URL to a Cohere/Jina-shaped " +
            "/rerank backend.",
        };
      }
      try {
        const probe = await ctx.reranker("liveness probe", ["alpha", "beta"], 1, []);
        return Array.isArray(probe) && probe.length > 0
          ? { live: true, detail: "" }
          : {
              live: false,
              detail:
                "RERANK_URL answered but returned no usable hits, so rerankWithScores would report " +
                "malformed_response and fall back to the input order — a gated-rerank arm in which " +
                "nothing was reranked.",
            };
      } catch (err) {
        return {
          live: false,
          detail:
            `the configured RERANK_URL backend failed a probe request (${
              err instanceof Error ? err.message : String(err)
            }). rerankWithScores catches this as provider_error and returns the input ranking, so ` +
            "the arm would score identically to its control.",
        };
      }
    },
  },
  decompose: {
    cli: "--decompose",
    // Two failures to separate, because they need different evidence. The daemon can be down, OR it
    // can be up without the configured model — and the second is invisible to a health ping:
    // /api/tags answers 200, /api/chat then 404s, and decomposeQuery() swallows that into [] by
    // design ("never breaks the eval"). Checking reachability alone would have let a
    // model-not-pulled run produce a stamped null.
    check: async (ctx) => {
      const fetchFn = ctx.fetchFn ?? fetch;
      const url = `${ctx.decomposeUrl.replace(/\/$/, "")}/api/tags`;
      const dead = (why: string): LivenessResult => ({
        live: false,
        detail:
          `the decomposition backend at ${ctx.decomposeUrl} is unreachable (${why}). ` +
          "decomposeQuery() swallows this and returns the original query, so the run would score " +
          "the baseline against itself. Point DECOMPOSE_URL at a live backend.",
      });
      let body: { models?: Array<{ name?: string; model?: string }> };
      try {
        const res = await fetchFn(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) return dead(`HTTP ${res.status}`);
        body = (await res.json()) as typeof body;
      } catch (err) {
        return dead(err instanceof Error ? err.message : String(err));
      }
      // Ollama reports "llama3.2:3b"; a request for an untagged "llama3.2" resolves to ":latest",
      // so match both rather than rejecting a legitimate shorthand.
      const installed = (body.models ?? [])
        .map((m) => m.name ?? m.model ?? "")
        .filter((n) => n.length > 0);
      const wanted = ctx.decomposeModel;
      const present = installed.some((n) => n === wanted || n === `${wanted}:latest`);
      return present
        ? { live: true, detail: "" }
        : {
            live: false,
            detail:
              `the decomposition backend at ${ctx.decomposeUrl} is reachable but does not have ` +
              `model "${wanted}" (installed: ${installed.length > 0 ? installed.join(", ") : "none"}). ` +
              "/api/chat would fail and decomposeQuery() would swallow it, so the run would score " +
              "the baseline against itself. Pull the model, or set DECOMPOSE_MODEL.",
          };
    },
  },
  activation: {
    cli: "--activation",
    // `run.ts` loads cached activation scores and DELIBERATELY degrades to an empty map on a
    // missing store or table — it even prints "running all-inert" and carries on. That is a
    // reasonable production read and an invalid measurement: a null activation is the inert
    // multiplier, so every candidate scores exactly as it would in the control while the artifact
    // records `activation`. This flag was originally classified dependency-free here; it reads an
    // external SQLite store, and two independent reviewers caught the misclassification.
    check: async (ctx) => ({
      live: ctx.activationRows > 0,
      detail:
        "no chunk carries cached activation state (0 rows loaded from experiential.db), so the " +
        "activation lookup returns null for every candidate and the arm scores identically to its " +
        "control. Populate vault_object_state.cached_activation_score first.",
    }),
  },
};

/** Artifact tokens for flags that DO carry an external dependency but already refuse inline, before
 *  this preflight runs. Listed rather than merged so the gate can tell "guarded here" from
 *  "guarded there" instead of reading an omission as safety. */
export const GUARDED_ELSEWHERE_FLAGS: ReadonlySet<string> = new Set([
  // Throws unless the variants file matches at least one golden query.
  "fanout",
  // Throws unless the index actually carries cluster_ids.
  "max-per-cluster",
]);

/** Artifact tokens for flags that are pure in-process code paths. Adding a flag here is a claim
 *  that it cannot silently no-op because there is nothing outside the process for it to miss. */
export const NO_EXTERNAL_DEPENDENCY_FLAGS: ReadonlySet<string> = new Set([
  "adaptive-rrf",
  "graph-stream",
  "smooth-expansion",
  "mmr",
  "no-lexical",
  "convex",
  "z-router",
  "metadata-prior",
  "temporal",
  "class-router",
  "path-dedup",
]);

export class InertEvalFlagError extends Error {
  constructor(readonly failures: readonly string[]) {
    super(
      `${failures.length} eval flag(s) would run as a SILENT NO-OP and report a null that reads ` +
        `as a measurement:\n\n${failures.map((f) => `  - ${f}`).join("\n")}\n\n` +
        "Refusing rather than emitting a scoreable artifact. Fix the dependency, or drop the flag " +
        "— a run without it is a valid run; a run with it and no backend is not.",
    );
    this.name = "InertEvalFlagError";
  }
}

/**
 * Refuse the run if any requested dependency-gated flag cannot actually do its work.
 *
 * `requested` holds artifact-token keys (the same strings that key `DEPENDENCY_GATED_FLAGS`);
 * unknown keys are ignored so callers can pass their whole flag list. Every gated flag is checked
 * before throwing, so one run surfaces every missing backend rather than one per attempt.
 */
export async function assertFlagDependencies(
  requested: readonly string[],
  ctx: FlagLivenessContext,
): Promise<void> {
  const failures: string[] = [];
  for (const key of requested) {
    const entry = DEPENDENCY_GATED_FLAGS[key];
    if (!entry) continue;
    const { live, detail } = await entry.check(ctx);
    if (!live) failures.push(`${entry.cli}: ${detail}`);
  }
  if (failures.length > 0) throw new InertEvalFlagError(failures);
}
