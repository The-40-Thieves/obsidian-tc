import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { LibsqlSyncOptions } from "./types";

/**
 * `storage.sync` -> the options `openDatabase` takes (`OpenOptions.sync`), or undefined when sync is
 * not configured. The token is read from the environment variable the config NAMES; it is never in
 * the config file. A named variable that is unset or empty is a hard error that names the variable
 * and never a value: silently opening a replica without its credentials would fail later, on the
 * first write, with a server error that does not say why.
 *
 * Not wired into the server boot path yet (a spike): nothing calls this outside its test.
 */
export function resolveLibsqlSync(
  cfg: Pick<ServerConfig, "storage">,
  env: NodeJS.ProcessEnv = process.env,
): LibsqlSyncOptions | undefined {
  const sync = cfg.storage?.sync;
  if (sync === undefined) return undefined;
  let authToken: string | undefined;
  if (sync.authTokenEnv !== undefined) {
    authToken = env[sync.authTokenEnv];
    if (authToken === undefined || authToken === "") {
      throw new Error(
        `storage.sync.authTokenEnv names ${sync.authTokenEnv}, but that environment variable is not set`,
      );
    }
  }
  return {
    url: sync.url,
    ...(authToken !== undefined ? { authToken } : {}),
    ...(sync.syncIntervalMs !== undefined ? { syncIntervalMs: sync.syncIntervalMs } : {}),
  };
}
