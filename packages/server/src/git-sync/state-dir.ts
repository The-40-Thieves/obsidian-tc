import { join, resolve } from "node:path";

/** The git-sync state directory under the server's cache directory. The sidecar (`env.ts`) and the
 *  vault-sync webhook route both derive their paths from it, so they cannot drift apart. */
export function gitSyncStateDir(cacheDir: string): string {
  return join(resolve(cacheDir), "git-sync");
}
