import type { EmbedderHost, EmbedderHostStats } from "./types";

// Every live host, grouped by the owner that built it (one boot's index resources). A registry
// rather than a field on the provider: the egress and revision wrappers in embeddings/index.ts
// rebuild the provider object field by field, so an extra property would not survive them. Owner
// keys (not one process-wide set) let a runtime close only its own hosts: tests build many runtimes
// in one process, and a sibling's shutdown must not close them.
const hostsByOwner = new WeakMap<object, Set<EmbedderHost>>();
// Every live host across owners, for the burst-end recycle policy and server_health, which name no owner.
const liveHosts = new Set<EmbedderHost>();

/** A close that never settles must not hang shutdown: past this the host is abandoned. */
const HOST_CLOSE_DEADLINE_MS = 5_000;

export function registerHost(owner: object, host: EmbedderHost): EmbedderHost {
  const owned = hostsByOwner.get(owner) ?? new Set<EmbedderHost>();
  owned.add(host);
  hostsByOwner.set(owner, owned);
  liveHosts.add(host);
  return host;
}

/** Every host still open, across owners. */
export function allLiveHosts(): EmbedderHost[] {
  return [...liveHosts];
}

/** The snapshot of the first child-process host, or undefined when none is open (in-process only). */
export function childHostSnapshot(): EmbedderHostStats | undefined {
  for (const host of liveHosts) {
    if (host.kind === "child-process") return host.snapshot();
  }
  return undefined;
}

/** Shutdown hook for one owner. Closes only that owner's hosts and never rejects: each close is
 *  isolated and bounded, so one failing or stalled close cannot skip the rest. */
export async function closeOwnedHosts(owner: object): Promise<void> {
  const live = [...(hostsByOwner.get(owner) ?? [])];
  hostsByOwner.delete(owner);
  for (const host of live) liveHosts.delete(host);
  await Promise.all(live.map(closeBounded));
}

async function closeBounded(host: EmbedderHost): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      host.close(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("embedder host close exceeded its deadline")),
          HOST_CLOSE_DEADLINE_MS,
        );
      }),
    ]);
  } catch {
    /* best-effort: one host failing or stalling to close must not skip the others */
  } finally {
    clearTimeout(deadline);
  }
}
