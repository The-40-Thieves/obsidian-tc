import type { EmbedderHost } from "./types";

// Every live host in this process. A registry rather than a field on the provider: the egress and
// revision wrappers in embeddings/index.ts rebuild the provider object field by field, so an extra
// property would not survive them.
const hosts = new Set<EmbedderHost>();

export function registerHost(host: EmbedderHost): EmbedderHost {
  hosts.add(host);
  return host;
}

/** Shutdown hook. Closes every registered host and never rejects: each close is isolated, so one
 *  failing close cannot skip the rest. */
export async function closeAllHosts(): Promise<void> {
  const live = [...hosts];
  hosts.clear();
  await Promise.all(
    live.map(async (host) => {
      try {
        await host.close();
      } catch {
        /* best-effort: one host failing to close must not skip the others */
      }
    }),
  );
}
