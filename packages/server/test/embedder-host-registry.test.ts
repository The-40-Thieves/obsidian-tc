// GH #1433 rec 4, step 3: the live-host registry the burst-end policy and server_health read. A host
// built with no owner (CLI or eval) has nothing that closes it, so it must not be held here: the
// registry would keep its loaded model reachable for the life of the process.
import { afterEach, describe, expect, it } from "vitest";
import { allLiveHosts, closeOwnedHosts, registerHost } from "../src/embeddings/host/registry";
import type { EmbedderHost } from "../src/embeddings/host/types";

const owner = {};

function fakeHost(): EmbedderHost {
  const stats = { state: "idle" as const, restarts: 0, recycles: 0 };
  return {
    kind: "child-process",
    embed: async () => [],
    recycle: async () => {},
    stats: async () => stats,
    snapshot: () => stats,
    close: async () => {},
  };
}

afterEach(async () => {
  await closeOwnedHosts(owner);
});

describe("registerHost live-host registry (GH #1433 step 3)", () => {
  it("a host built with no owner is absent from allLiveHosts()", () => {
    const ownerless = fakeHost();
    registerHost(undefined, ownerless);
    expect(allLiveHosts()).not.toContain(ownerless);
  });

  it("a host built with an owner is listed by allLiveHosts() until its owner closes it", async () => {
    const owned = fakeHost();
    registerHost(owner, owned);
    expect(allLiveHosts()).toContain(owned);
    await closeOwnedHosts(owner);
    expect(allLiveHosts()).not.toContain(owned);
  });
});
