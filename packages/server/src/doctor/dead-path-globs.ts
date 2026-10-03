// config.path-globs — a configured vault-path glob that matches NO file in its vault: a "dead
// pattern". It is a warning, never a failure (a glob may name a folder that does not exist yet),
// but the wording depends on which way the field fails:
//   - a RESTRICTION (egress.excludePaths, acl.rules, vaults[].index.excludePaths) that matches
//     nothing restricts nothing — it fails OPEN, so the note it was meant to withhold is exposed;
//   - a WHITELIST (acl.readPaths/writePaths/deletePaths) that matches nothing grants nothing —
//     it fails closed, which is safe but is rarely what the operator meant.
// Own module, same reasoning as memory-read-acl.ts: a pure classifier over an already-resolved view
// (the vault's file list is injected, so the check is testable with no filesystem).
import { globMatch } from "../acl";
import { compileEgressFilter, isExcludedPath } from "../plane/egress-filter";
import { compileExclusionEntries } from "../search/index-exclusion";
import { walkVault } from "../vault/paths";
import { canonicalizeVaultRoot } from "../vault/registry";
import type { Check, CheckResult, CheckStatus } from "./types";

/** One configured pattern and the vaults it applies to. `matches` is the SAME predicate the
 *  enforcing code uses for that field, so a "dead" verdict cannot disagree with enforcement. */
export interface PathGlobEntry {
  /** The config key, e.g. `egress.excludePaths` or `vaults[main].acl.rules[].glob`. */
  field: string;
  pattern: string;
  /** True for a restriction that fails OPEN when it matches nothing. */
  failOpen: boolean;
  vaultIds: readonly string[];
  matches: (relPath: string) => boolean;
}

export interface DeadPathGlobsView {
  entries: readonly PathGlobEntry[];
  /** Vault id -> its vault-relative file list; `undefined` when the vault could not be walked. */
  files: ReadonlyMap<string, readonly string[] | undefined>;
}

/** The pattern -> predicate for each field, mirroring the enforcing compiler. A pattern the
 *  compiler refuses (egress's unusable spellings) yields no entry: config load already refuses it. */
const aclMatcher = (glob: string) => (rel: string) => globMatch(glob, rel);

function egressMatcher(pattern: string): ((rel: string) => boolean) | undefined {
  try {
    const filter = compileEgressFilter([pattern]);
    return (rel) => isExcludedPath(filter, rel);
  } catch {
    return undefined;
  }
}

function indexMatcher(entry: string): ((rel: string) => boolean) | undefined {
  const trimmed = entry.trim();
  if (trimmed === "") return undefined;
  const { test, invalid } = compileExclusionEntries([trimmed]);
  return invalid.length > 0 ? undefined : test;
}

interface AclPathsView {
  rules: readonly { glob: string }[];
  readPaths?: readonly string[] | undefined;
  writePaths?: readonly string[] | undefined;
  deletePaths?: readonly string[] | undefined;
}

/** The slice of the parsed config this check reads. Structural, so doctor passes `config` as is. */
export interface PathGlobConfigView {
  acl: AclPathsView;
  egress: { excludePaths: readonly string[] };
  vaults: readonly {
    id: string;
    path: string;
    acl?: AclPathsView | undefined;
    index?: { excludePaths: readonly string[] } | undefined;
  }[];
}

/** Every path-glob field in the config, with the vaults it governs. A global `acl` block governs
 *  the vaults that carry no `acl` of their own (buildAcls); `egress.excludePaths` governs all. */
export function pathGlobEntries(config: PathGlobConfigView): PathGlobEntry[] {
  const out: PathGlobEntry[] = [];
  const allIds = config.vaults.map((v) => v.id);
  const aclEntries = (prefix: string, acl: AclPathsView, vaultIds: readonly string[]): void => {
    if (vaultIds.length === 0) return;
    for (const r of acl.rules)
      out.push({
        field: `${prefix}.rules[].glob`,
        pattern: r.glob,
        failOpen: true,
        vaultIds,
        matches: aclMatcher(r.glob),
      });
    for (const key of ["readPaths", "writePaths", "deletePaths"] as const)
      for (const glob of acl[key] ?? [])
        out.push({
          field: `${prefix}.${key}`,
          pattern: glob,
          failOpen: false,
          vaultIds,
          matches: aclMatcher(glob),
        });
  };
  aclEntries(
    "acl",
    config.acl,
    config.vaults.filter((v) => v.acl === undefined).map((v) => v.id),
  );
  for (const pattern of config.egress.excludePaths) {
    const matches = egressMatcher(pattern);
    if (matches)
      out.push({
        field: "egress.excludePaths",
        pattern,
        failOpen: true,
        vaultIds: allIds,
        matches,
      });
  }
  for (const v of config.vaults) {
    if (v.acl) aclEntries(`vaults[${v.id}].acl`, v.acl, [v.id]);
    for (const pattern of v.index?.excludePaths ?? []) {
      const matches = indexMatcher(pattern);
      if (matches)
        out.push({
          field: `vaults[${v.id}].index.excludePaths`,
          pattern,
          failOpen: true,
          vaultIds: [v.id],
          matches,
        });
    }
  }
  return out;
}

/** The check's input for a loaded config: every glob, plus each vault's file list. A vault that
 *  cannot be walked (symlinked root, unreadable) is `undefined`: reported as unchecked, never as
 *  "every glob dead". */
export function deadPathGlobsView(config: PathGlobConfigView): DeadPathGlobsView {
  return {
    entries: pathGlobEntries(config),
    files: new Map(
      config.vaults.map((v) => {
        try {
          return [v.id, walkVault(canonicalizeVaultRoot(v.path)).map((e) => e.relPath)] as const;
        } catch {
          return [v.id, undefined] as const;
        }
      }),
    ),
  };
}

export function deadPathGlobsCheck(view: DeadPathGlobsView): Check {
  return {
    id: "config.path-globs",
    category: "config",
    run: (): CheckResult => {
      const unchecked: string[] = [];
      for (const [id, files] of view.files) {
        if (files === undefined) unchecked.push(`${id} (vault could not be listed)`);
        else if (files.length === 0) unchecked.push(`${id} (vault has no files)`);
      }
      const dead = view.entries.filter((e) => {
        const listed = e.vaultIds.flatMap((id) => {
          const files = view.files.get(id);
          return files !== undefined && files.length > 0 ? [files] : [];
        });
        // Nothing to judge it against: not dead, just unchecked (reported in `notes`).
        if (listed.length === 0) return false;
        return !listed.some((files) => files.some((f) => e.matches(f)));
      });
      const notes = unchecked.length > 0 ? [`not checked: ${unchecked.join("; ")}`] : undefined;
      if (dead.length === 0) {
        return {
          status: "ok" as CheckStatus,
          summary: "every configured path glob matches at least one file in its vault",
          details: { patterns: String(view.entries.length) },
          ...(notes ? { notes } : {}),
        };
      }
      const issues = dead.map((e) =>
        e.failOpen
          ? `${e.field} "${e.pattern}" matches no file: this restriction protects NOTHING (it fails open), so the notes it was meant to cover are not covered`
          : `${e.field} "${e.pattern}" matches no file: this whitelist entry grants nothing`,
      );
      return {
        status: "warning" as CheckStatus,
        summary: `${dead.length} configured path glob(s) match no file (${dead.filter((e) => e.failOpen).length} fail open)`,
        details: { dead: dead.map((e) => `${e.field}: ${e.pattern}`) },
        issues,
        ...(notes ? { notes } : {}),
        remediation:
          "Check each pattern's spelling, letter case and folder name against the vault. Write separators as `/` (a backslash is read as a separator); globs are vault-relative with no leading `/`. A pattern for a folder that does not exist yet is fine, but until the folder appears a restriction pointed at it restricts nothing.",
      };
    },
  };
}
