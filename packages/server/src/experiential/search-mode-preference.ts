// The reader for `preferred.search_mode` (retrieval.useSearchModePreference, default off).
//
// `extractPreferences` (reflect.ts) has written this key since THE-673 but nothing on the serve path
// read it. This is the one consumer: a `search_vault` call that named no `mode` may take the
// caller's learned mode instead of `auto`. It is a DEFAULT-SELECTOR, never an override — an
// explicit `mode` (including an explicit "auto") always wins — and it is ranking-adjacent, so it
// ships dark behind the flag pending the eval recorded in the PR that introduced it (ADR-0007).
//
// WHAT THE STORED VALUE IS. The producer records a TOOL NAME (the majority search-family tool of a
// judged window), not a search_vault mode. Only one of the five stored values has a search_vault
// counterpart that is safe to force on a call that did not ask for it:
//   search_text          -> "text"   (a string query, exactly what `text` takes)
//   search_regex         -> NONE     a regex is a pattern language; the query of a mode-less call is
//                                    natural language, and forcing `regex` on it turns calls that
//                                    work today into invalid_input (the ReDoS guard, bad syntax)
//   search_vault         -> NONE     it is the router itself; choosing it says nothing about a mode
//   vault_graph_search   -> NONE     different tool, different engine
//   search_omnisearch    -> NONE     different tool, needs the Omnisearch bridge
// An unmapped value resolves to the default, never to an error.
//
// CONFIDENCE. `preference_profile.weight` is a counter in [0, 5]: the first observation sets 1.0,
// each further agreeing one adds 0.5, a disagreeing judged window subtracts 0.5. It is NOT a
// per-value tally (one row holds one value, and an `add` for a different tool overwrites the value
// while the weight keeps climbing), and it is NOT a count of distinct windows either:
// `extractPreferences` re-reads the newest judged windows on every run and re-applies them, so one
// unchanged window reaches 3.0 after five `obsidian-tc reflect` runs (measured, see the PR that
// added this reader). The weight therefore measures "evidence observed across extraction passes".
// `SEARCH_MODE_MIN_WEIGHT` of 3.0 is a floor against a single fresh observation steering a caller,
// not a statistical confidence. Making extraction idempotent (a per-window watermark) is what
// would turn this into a real count, and is why extraction is deliberately not scheduled.
//
// SCOPE. `preferred.search_mode` is declared "caller"-scoped (PREFERENCE_KEYS): it encodes the
// OBSERVING AGENT's own workload and must not steer another principal's retrieval. `preferenceProfile`
// returns the shared '' partition UNION the caller's own, which is right for a human-scoped key but
// would hand a named caller the stdio/unauthenticated principal's row here; so entries are filtered
// to the key's declared scope. A null caller (the single trusted local principal) reads the ''
// partition. The vault is the resolved search target, so one vault's profile never steers another.
import type { Database } from "../db/types";
import { PREFERENCE_KEYS, preferenceProfile } from "./reflect";

const KEY = "preferred.search_mode";

/** The search_vault modes a caller may name. Kept here so the reader and the tool cannot drift. */
export type SearchVaultMode = "auto" | "text" | "regex" | "dql" | "jsonlogic" | "semantic";

/** Who chose the mode: the caller (`explicit`, including an explicit "auto"), the stored profile
 *  (`preference`), or the tool's own `auto` (`default`). Reported by search_vault when the flag is
 *  on — a label only, never content. */
export type ModeSource = "explicit" | "preference" | "default";

/** Minimum `preference_profile.weight` for the stored mode to be used. See the header. */
export const SEARCH_MODE_MIN_WEIGHT = 3;

/** Stored tool name -> search_vault mode. Absent = no safe counterpart (see the header). */
const TOOL_TO_MODE: ReadonlyMap<string, SearchVaultMode> = new Map([["search_text", "text"]]);

export interface ResolveSearchModeInput {
  /** The `mode` the caller passed, undefined when they omitted it. */
  explicit: SearchVaultMode | undefined;
  /** True when the query is a string. A preference never applies to an object (jsonlogic) query. */
  stringQuery: boolean;
  edb: Database;
  vaultId: string;
  caller: string | null;
}

export function resolveSearchVaultMode(input: ResolveSearchModeInput): {
  mode: SearchVaultMode;
  source: ModeSource;
} {
  if (input.explicit !== undefined) return { mode: input.explicit, source: "explicit" };
  const fallback = { mode: "auto" as const, source: "default" as const };
  if (!input.stringQuery) return fallback;
  try {
    const scope = PREFERENCE_KEYS.get(KEY)?.scope ?? "caller";
    const want = scope === "human" ? "" : (input.caller ?? "");
    const row = preferenceProfile(input.edb, input.vaultId, input.caller).entries.find(
      (e) => e.key === KEY && e.scope_caller === want,
    );
    if (row === undefined || row.weight < SEARCH_MODE_MIN_WEIGHT) return fallback;
    const mode = TOOL_TO_MODE.get(row.value);
    return mode === undefined ? fallback : { mode, source: "preference" };
  } catch {
    // A preference read must never fail a search: a closed store or a missing table is "no profile".
    return fallback;
  }
}
