// vault.io — which backend note reads run through (vault/notes-io.ts). The native addon walks each
// path component with openat(O_NOFOLLOW) and closes the intermediate-directory symlink-swap race on
// Unix. Without it, the pure-JS read closes the race on Linux (the opened descriptor's path is
// checked via procfs) and is best-effort on macOS, where only the ancestors are re-walked. Windows
// always takes the pure-JS read: the native open is Unix-only.
import type { Check, CheckResult } from "./types";

export interface VaultIoView {
  /** vault/notes-io.ts `nativeVaultIo`: the native addon loaded. */
  nativeLoaded: boolean;
  /** `process.platform`, injected so each platform can be checked under test. */
  platform: string;
}

export function vaultIoCheck(view: VaultIoView): Check {
  return {
    id: "vault.io",
    category: "config",
    run: (): CheckResult => {
      if (view.nativeLoaded) {
        return {
          status: "ok",
          summary: "vault I/O: native addon (per-component openat walk, symlink-safe)",
        };
      }
      if (view.platform === "linux") {
        return {
          status: "ok",
          summary:
            "vault I/O: pure-JS fallback; the opened descriptor's path is checked via /proc/self/fd",
        };
      }
      const remediation =
        view.platform === "win32"
          ? "Windows always reads through the pure-JS path (the native open is Unix-only), so treat vault reads there as best-effort against a concurrent symlink swap."
          : "Install the native addon, which closes the race with an openat walk, or do not set OBSIDIAN_TC_FORCE_JS_FALLBACK=1 when it loads.";
      return {
        status: "warning",
        summary: `vault I/O: pure-JS fallback on ${view.platform}; reads are best-effort against a concurrent symlink swap`,
        issues: [
          "a concurrent symlink swap of an ancestor directory between the path check and the open can be followed; this platform has no descriptor-path check",
        ],
        remediation,
      };
    },
  };
}
