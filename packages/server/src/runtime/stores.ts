// WP5.1 (issue 15): run_serve's cache.db / experiential.db provisioning, extracted verbatim out of
// cli.ts so the two-tier store boundary (THE-233 W-SCHEMA) is constructible in a test without
// parsing process arguments. Behaviour is unchanged: the experiential membrane is provisioned then
// released (closed) the moment nothing on the process needs it, exactly as before — see
// `experientialOpen` below, which is still decided from the SAME three feature gates.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { provisionExperientialDb } from "../db/experiential";
import type { Migration } from "../db/migrate";
import { openDatabase } from "../db/open";
import { provisionCacheDb } from "../db/provision";
import type { Database } from "../db/types";
import { makeActivationLookup } from "../experiential/activation";
import { createEpisodeCapture, type EpisodeSink } from "../experiential/episodes";
import { createRetrievalLogger, type RetrievalLogger } from "../experiential/log";
import { stderrOnError } from "../util/errors";
import { formatVaultRenameNotice, resolveAndApplyVaultIdentity } from "../vault/identity";
import { withBootstrapBarrier } from "./vault-lock";

export interface StoresDeps {
  cacheDir: string;
  version: string;
  /** THE-935: config's `db.busyTimeoutMs`, forwarded to both cache.db and experiential.db.
   *  Omitted falls back to DEFAULT_BUSY_TIMEOUT_MS (db/pragmas.ts). */
  busyTimeoutMs?: number;
  /** config.experiential — the three independent capture gates plus the redaction flag. */
  experiential: {
    logRetrievals: boolean;
    captureEpisodes: boolean;
    captureContent: boolean;
    activationRerank: boolean;
  };
  /** THE-233 (W-SCHEMA): the experiential tier's append-only migration set. Passed in rather than
   *  imported so this module never depends on cli/shared.ts (a dependency-direction leaf rule, not
   *  a functional one — the migrations themselves are unchanged). */
  experientialMigrations: Migration[];
  /** Stable vault identity (20260928_001): `{ id, path }` for every configured vault, resolved
   *  against `vault_identity` right after both stores provision — see vault/identity.ts's
   *  `resolveAndApplyVaultIdentity` doc comment for why this must run here (post-migration,
   *  pre-experientialDb-close, inside the same bootstrap barrier that serializes migrations
   *  across racing processes). */
  vaults: readonly { id: string; path: string }[];
}

export interface Stores {
  db: Database;
  experientialDb: Database;
  /** THE-230: serve-path retrieval logging. Present only when experiential.logRetrievals. */
  retrievalLog?: RetrievalLogger;
  /** THE-228: capture-everything episode bus. Present only when experiential.captureEpisodes. */
  episodeCapture?: EpisodeSink;
  /** THE-187/193: serve-side activation lookup for the bubble pass. Present only when
   *  experiential.activationRerank. */
  activationFor?: (chunkId: string) => number | null;
  /** True while experientialDb is held open for the process lifetime (any of the three gates
   *  above). False means experientialDb was already provisioned-then-released by the time this
   *  function returns — see the constructor below, unchanged from the inline cli.ts behaviour. */
  experientialOpen: boolean;
  /** Idempotent. Closes both `db` and, when `experientialOpen` left it open past boot,
   *  `experientialDb` too — a live server relied on process exit to reclaim the second handle
   *  (harmless on POSIX; a real leak of a shared close contract, not merely academic once anything
   *  closes-then-immediately-removes the files underneath it, e.g. `session_rerun`'s sandbox
   *  runtime and `rerun --sandbox`'s own disposal, both of which stage cache.db AND
   *  experiential.db and then rmSync the directory they live in — on Windows a still-open handle
   *  on either file blocks that removal outright). */
  close(): void;
}

/**
 * Open cache.db and experiential.db and derive the experiential capture ports. THE-233 (W-SCHEMA):
 * experiential.db is a physically separate store (the membrane — low-trust per-retrieval state
 * cannot FK into the authored atoms in cache.db, and a reset is a file truncate). THE-230/THE-228:
 * retrievalLog and episodeCapture share the one experientialDb handle, held open for the process
 * lifetime when either is enabled; with all three gates off the store is provisioned-then-released.
 */
export async function wireStores(deps: StoresDeps): Promise<Stores> {
  mkdirSync(deps.cacheDir, { recursive: true });
  const db = await openDatabase(join(deps.cacheDir, "cache.db"), deps.busyTimeoutMs);
  provisionCacheDb(db, { version: deps.version });
  const experientialDb = await provisionExperientialDb(deps.cacheDir, deps.experientialMigrations, {
    version: deps.version,
    busyTimeoutMs: deps.busyTimeoutMs,
  });
  // Stable vault identity (20260928_001): must run AFTER both stores are migrated (vault_identity
  // exists, and experiential.db's tables are there to re-key) and BEFORE experientialDb is
  // possibly closed below (experientialOpen === false) — a rename needs a live handle on both.
  // See vault/identity.ts's `resolveAndApplyVaultIdentity` for the full rationale.
  for (const notice of resolveAndApplyVaultIdentity(db, experientialDb, deps.vaults)) {
    process.stderr.write(formatVaultRenameNotice(notice));
  }
  const retrievalLog = deps.experiential.logRetrievals
    ? createRetrievalLogger(experientialDb, { onError: stderrOnError("retrieval-log") })
    : undefined;
  const episodeCapture = deps.experiential.captureEpisodes
    ? createEpisodeCapture(experientialDb, {
        captureContent: deps.experiential.captureContent,
        onError: stderrOnError("episodes"),
      })
    : undefined;
  const activationFor = deps.experiential.activationRerank
    ? makeActivationLookup(experientialDb, { onError: stderrOnError("activation-read") })
    : undefined;
  const experientialOpen = !!(retrievalLog || episodeCapture || activationFor);
  if (!experientialOpen) experientialDb.close?.();

  return {
    db,
    experientialDb,
    ...(retrievalLog ? { retrievalLog } : {}),
    ...(episodeCapture ? { episodeCapture } : {}),
    ...(activationFor ? { activationFor } : {}),
    experientialOpen,
    close: () => {
      db.close?.();
      if (experientialOpen) experientialDb.close?.();
    },
  };
}

/**
 * GH #995 fix round (COLD_BOOT_PRELOCK): `wireStores` behind `withBootstrapBarrier`, extracted
 * out of server-runtime.ts (which was pushing biome's 700-line noExcessiveLinesPerFile ceiling —
 * same reason shutdown-phase.ts's helpers were extracted) rather than left as an inline wrap. See
 * `withBootstrapBarrier`'s own doc comment (vault-lock.ts) for the migration race this closes.
 */
export async function wireStoresBehindBootstrapBarrier(deps: StoresDeps): Promise<Stores> {
  return withBootstrapBarrier(deps.cacheDir, () => wireStores(deps));
}
