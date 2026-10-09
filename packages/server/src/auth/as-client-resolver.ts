// The client resolver the AS routes share (design v2 section 4.7): one per route-deps object, so
// authorize, consent, token and revoke look a client up the same way and share one in-flight table.
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { type ClientResolver, createClientResolver } from "./as-cimd";
import type { AsRouteDeps } from "./as-metadata";

type AsConfig = NonNullable<ServerConfig["auth"]["as"]>;

const defaultLog = (line: string): void => {
  process.stderr.write(`[as] ${line}\n`);
};

const resolvers = new WeakMap<AsRouteDeps, ClientResolver>();

export function clientResolverFor(deps: AsRouteDeps, as: AsConfig): ClientResolver {
  let r = resolvers.get(deps);
  if (r === undefined) {
    r = createClientResolver({
      clients: as.clients,
      allowedHosts: as.cimd.allowedHosts,
      db: deps.db,
      now: deps.now ?? Date.now,
      log: deps.log ?? defaultLog,
      seams: deps.cimd,
    });
    resolvers.set(deps, r);
  }
  return r;
}
