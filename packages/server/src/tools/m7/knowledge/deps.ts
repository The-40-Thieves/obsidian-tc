// WP2 slice 1: M7Deps, moved verbatim out of knowledge-tools.ts. Types only — no runtime code
// belongs here, and nothing here may import knowledge-tools.ts (the facade) or retrieval-runtime.ts.
import type { FolderAcl } from "../../../acl";
import type { Database } from "../../../db/types";
import type { EmbeddingProvider } from "../../../embeddings";
import type { RetrievalLogger } from "../../../experiential/log";
import type { GatewayRoles } from "../../../plane/gateway";
import type { StageMetric } from "../../../search/graph_search_stages/instrumentation";
import type { RetrievalCaches } from "../../../search/query_cache";
import type { Reranker, RerankOutcome } from "../../../search/rerank";
import type { VaultRegistry } from "../../../vault/registry";

export interface M7Deps {
  vaultRegistry: VaultRegistry;
  embeddingProvider: EmbeddingProvider;
  /** Rerank seam → gateway /rerank passthrough; null when the gateway is unconfigured. */
  reranker: Reranker | null;
  /** Generative roles → gateway extract/synthesize/judge; null when unconfigured. */
  roles: GatewayRoles | null;
  /** THE-397: config-driven retrieval knobs (config.retrieval); absent -> graphSearch defaults. */
  retrieval?: {
    rrfK?: number;
    sparse?: boolean;
    colbert?: boolean;
    densify?: { includeInWalk?: boolean; derivedWeight?: number };
    /** THE-391/THE-536: adaptive per-stream RRF weighting. Absent/false -> static RRF, byte-
     *  identical to today. */
    adaptiveRrf?: { enabled?: boolean; gain?: number };
    /** THE-393/THE-693: the capped expansion stream + hub degree cap. Read by graph_expansion.ts
     *  since THE-393 but with NO config surface until THE-693 — the only code that ever set it was
     *  the eval harness, so the hub defence was unreachable in production. Absent/false ->
     *  byte-identical to today. */
    graphStream?: {
      enabled?: boolean;
      expansionSeeds?: number;
      perSeedCap?: number;
      hubDegreeCap?: number;
    };
    /** THE-394/THE-591: gated cross-encoder rerank (retrieval.gatedRerank). Absent/false ->
     *  graphSearch's gatedRerank stage never fires, byte-identical to today. */
    gatedRerank?: boolean;
    /** THE-806: which hardness rule the gate uses (retrieval.gatedRerankHardness), and the only
     *  config path to it. Read ONLY when `gatedRerank` is true.
     *
     *  Optional here because the schema `.prefault({})`s it, so a real config always supplies it
     *  and only fixtures omit it. `gatedRerankOptionsFromConfig` owns the fallback, and
     *  `gated-rerank-hardness-config.test.ts` pins that fallback to the SCHEMA's parsed defaults —
     *  two sources of a default that cannot silently disagree. */
    gatedRerankHardness?: {
      mode: "cosine" | "zMargin";
      hardTop1: number;
      hardZ: number;
      pool: number;
    };
    /** THE-628 (first PR): the note-level summary candidate stream (retrieval.summaries). Dark by
     *  default — absent/false means graphSearch never queries note_summaries, byte-identical to
     *  today. `model`/`maxConcurrency` govern the INDEX-time summarizer (search/indexing/
     *  summarize-notes.ts, wired at the `obsidian-tc index` CLI command in this first PR), not the
     *  retrieval side — kept here anyway so the whole retrieval.summaries block threads through
     *  one M7Deps field instead of splitting index-time and retrieval-time config across two
     *  places. */
    summaries?: { enabled?: boolean; model?: string; maxConcurrency?: number };
  };
  /** Config-driven POST-FUSION ranking overlays (config.ranking); absent -> graphSearch defaults
   *  (metadata prior OFF). */
  ranking?: {
    metadataPrior?: {
      enabled?: boolean;
      rules?: Array<{ field: string; value: string; boost: number }>;
      clampFraction?: number;
    };
  };
  /** THE-230: serve-path retrieval logging into the experiential store; absent -> no logging. */
  retrievalLog?: RetrievalLogger;
  /** THE-585 (#7, #8): one vec0 -> brute-force degradation, by vault and reason. Absent -> inert,
   *  matching retrievalLog above. Wired from the composition root so this module never learns
   *  about the metrics recorder. */
  onVecFallback?: (vault: string, reason: "error" | "underfill") => void;
  /** THE-585 (#6): one record per named retrieval stage (duration + candidate funnel), by vault.
   *  The `onStageMetric` seam and its closed `StageName` union already existed (THE-465); this is
   *  the missing half — nothing consumed it outside the perf collector. Absent -> inert. */
  onStageMetric?: (vault: string, metric: StageMetric) => void;
  /** one rerankWithScores decision (why the returned ranking is what it is — not
   *  configured, policy-skipped, executed, timed out, malformed, or errored), by vault. Same seam
   *  shape as onVecFallback/onStageMetric above — wired from the composition root so this module
   *  never learns about the metrics recorder. Absent -> inert. */
  onRerankOutcome?: (vault: string, outcome: RerankOutcome) => void;
  /** THE-187/193: cached_activation_score lookup for the graph bubble pass; absent -> inert
   *  (the config-gated dark default until the A/B passes the ship rule). */
  activationFor?: (chunkId: string) => number | null;
  /** THE-258: the deterministic class router (retrieval.classRouter). Dark by default —
   *  absent/false, every query takes the measured standard path. */
  classRouter?: boolean;
  /** THE-132/229: open experiential handle for vault_context's include_work leg; absent ->
   *  include_work reports work_unavailable. */
  edb?: Database;
  /** THE-231: per-vault memory folder (same source as M5) — where the next-session signal
   *  note lives for vault_context's bootstrap mode; absent -> "memory". */
  memoryFolder?: (vaultId: string) => string;
  /** THE-136: directory holding the prewarm cache (prewarm-<vault>.json). When set, bootstrap
   *  mode reads a fresh entry instead of cold-querying and writes through on a live compose;
   *  absent -> every bootstrap composes live. */
  prewarmDir?: string;
  /** THE-562 P1.6: governed-write handles so reflect.persist snapshots + reindexes like write_note. */
  snapshots?: { enabled: boolean; retention: number };
  reindex?: (vaultId: string, path: string, content: string) => void;
  /** THE-497: the in-process query-product cache (retrieval.cache). Absent -> every retrieval
   *  surface below embeds and searches exactly as it did before, with no cache path taken. */
  retrievalCaches?: RetrievalCaches;
  /** THE-630: federated multi-vault search's ACL source. `aclByVault` is the SAME map governance.ts
   *  builds at boot (one entry per vault with its OWN `acl` config override); `acl` is the root ACL
   *  every vault without an override inherits — the identical `aclByVault.get(id) ?? acl` fallback
   *  `acl.ts`'s `makeIndexReadable` and governance.ts's own `aclResolver` already use, so a vault
   *  with no per-vault override resolves to the SAME ACL under federation as it does today under
   *  the single-vault path (never "no ACL at all", which would be MORE permissive than intended).
   *
   *  Both optional/additive: every M7 tool factory other than vault_graph_search's federated branch
   *  ignores these, and a deployment that never wires them simply cannot reach federation with a
   *  configured ACL (the federated branch resolves to `undefined` for every vault, which reads as
   *  "no ACL" — the same "absent ACL -> unrestricted" convention `CallerContext.acl` already uses).
   *
   *  NEVER read through `ctx.acl` for a federated leg — `ctx.acl` is set once, by central dispatch's
   *  THE-295 swap, for the SINGLE vault named in the tool's declared `vaultArg` field. A federated
   *  call touches N vaults, so `ctx.acl` can describe at most one of them correctly. */
  acl?: FolderAcl;
  aclByVault?: Map<string, FolderAcl>;
}
