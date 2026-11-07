// vaults.case-sensitivity — the case behavior each vault's folder ACL was compiled with. ACL
// matching is a per-vault FILESYSTEM fact (vault/case-sensitivity.ts), not the process platform
// constant it was before: a vault on a case-sensitive APFS volume under macOS, or on a
// case-insensitive mount under Linux, is matched its own way now. The operator must be able to
// see that fact and, above all, see the one bad case: a root the probe could not read, where the
// fail-closed split governs (whitelists match case-sensitively, rule scopes and immutable globs
// fold) until vaults[].caseSensitive pins it.
//
// Own module, same reasoning as memory-read-acl.ts: a pure classifier over an already-resolved
// view (buildAcls' caseByVault), testable with no filesystem.
import type { VaultCaseInfo } from "../vault/case-sensitivity";
import type { Check, CheckResult } from "./types";

export interface VaultCaseSensitivityView {
  /** Per vault, the resolution buildAcls computed: the override, else the probe of its root. */
  vaults: readonly { id: string; info: VaultCaseInfo }[];
}

/** The view from buildAcls' caseByVault. A vault missing from the map (impossible through
 *  buildAcls, possible in a hand-built test) reads as the fail-closed unknown. */
export function vaultCaseSensitivityView(
  caseByVault: ReadonlyMap<string, VaultCaseInfo>,
  vaultIds: readonly string[],
): VaultCaseSensitivityView {
  return {
    vaults: vaultIds.map((id) => ({
      id,
      info: caseByVault.get(id) ?? {
        configured: "auto",
        detected: null,
        caseInsensitive: null,
        match: { allow: false, rules: true },
      },
    })),
  };
}

const describe = (info: VaultCaseInfo): string => {
  const what =
    info.caseInsensitive === null
      ? "unknown (whitelist matching is case-sensitive, scopes and immutable globs fold)"
      : info.caseInsensitive
        ? "case-insensitive"
        : "case-sensitive";
  const how = info.configured === "auto" ? "probed" : `configured: ${info.configured}`;
  return `${what}, ${how}`;
};

/**
 * vaults.case-sensitivity — WARNING only when a vault's case behavior is unknowable: nothing is
 * bypassed (the fail-closed split can only under-grant and over-restrict), but it is not the
 * behavior the operator chose, and it persists silently until pinned. Output is operator-only
 * (stdout of `doctor`), never a tool result.
 */
export function vaultCaseSensitivityCheck(view: VaultCaseSensitivityView): Check {
  return {
    id: "vaults.case-sensitivity",
    category: "security",
    run: (): CheckResult => {
      const details: Record<string, string | string[]> = {
        vaults: view.vaults.map((v) => `${v.id}: ${describe(v.info)}`),
      };
      const unknown = view.vaults.filter((v) => v.info.caseInsensitive === null);
      if (unknown.length === 0) {
        return {
          status: "ok",
          summary: "every vault's folder ACL matches its own filesystem's case behavior",
          details,
        };
      }
      return {
        status: "warning",
        summary: `${unknown.length} vault(s) whose filesystem case sensitivity could not be probed (matching fails closed)`,
        details,
        issues: unknown.map(
          (v) =>
            `vault ${v.id}: case sensitivity is unknown — whitelists match case-sensitively while rule scopes and immutable globs fold, the fail-closed split`,
        ),
        remediation:
          'Set vaults[].caseSensitive (true/false) for each named vault to pin the behavior its filesystem actually has, or "auto" to retry the probe at the next start. The split cannot be bypassed — it can only deny a legitimate case-variant read or over-demand a scope — but it is not the behavior the filesystem would give.',
      };
    },
  };
}
