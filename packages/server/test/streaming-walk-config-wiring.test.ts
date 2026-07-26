// THE-591 — proves indexing.streamingWalk is actually REACHABLE end to end: a config value
// threaded through M2Deps (registerM2Tools -> the index_vault tool) reaches indexVault's
// `walk.streaming` switch and OBSERVABLY changes which walk primitive runs — not merely that the
// option was passed. THE-490 built walkVaultStream and indexVault's internal switch on it
// (proven order-independent by test/index-stream-walk-equivalence.test.ts), but nothing in
// production ever set the switch: there was no config key, so config.indexing.streamingWalk did
// not exist and the index_vault tool never passed `walk.streaming` at all.
//
// The observable seam is the walk primitive itself (walkVault vs walkVaultStream), spied via
// vi.doMock on ../src/vault/paths — asserting on the config value passed in would prove nothing
// (it would pass even if indexVault silently ignored it, which is exactly the bug this ticket
// closes).
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../src/vault/paths");
  vi.resetModules();
});

/** Mocks ../src/vault/paths so walkVault/walkVaultStream still do their real work, but every call
 *  is counted — the seam THE-490's opt-in switch actually dispatches on inside indexVault. */
async function spyOnWalkPrimitives() {
  vi.resetModules();
  vi.doMock("../src/vault/paths", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/vault/paths")>();
    return {
      ...actual,
      walkVault: vi.fn(actual.walkVault),
      walkVaultStream: vi.fn(actual.walkVaultStream),
    };
  });
  return await import("../src/vault/paths");
}

const FILES = { "a.md": "alpha note body", "sub/b.md": "beta note body" };

describe("THE-591 — indexing.streamingWalk config wiring (index_vault tool)", () => {
  // vi.resetModules() per test (needed to swap the mocked walk primitives cleanly) re-evaluates
  // the whole module graph each time, which is slower than the default 5s budget under load.
  it("FLAG UNSET/false: walks via walkVault, never touches walkVaultStream", async () => {
    const paths = await spyOnWalkPrimitives();
    const { makeM2Vault } = await import("./m2-helpers");
    const v = makeM2Vault({ files: FILES });
    try {
      await v.call("index_vault", { vault: v.id });
      expect(paths.walkVault).toHaveBeenCalled();
      expect(paths.walkVaultStream).not.toHaveBeenCalled();
    } finally {
      v.cleanup();
    }
  }, 15000);

  it("FLAG true: walks via walkVaultStream, never touches the eager walkVault", async () => {
    const paths = await spyOnWalkPrimitives();
    const { makeM2Vault } = await import("./m2-helpers");
    const v = makeM2Vault({ files: FILES, streamingWalk: true });
    try {
      await v.call("index_vault", { vault: v.id });
      expect(paths.walkVaultStream).toHaveBeenCalled();
      expect(paths.walkVault).not.toHaveBeenCalled();
    } finally {
      v.cleanup();
    }
  }, 15000);
});
