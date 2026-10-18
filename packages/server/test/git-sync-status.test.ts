import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { StatusStore } from "../src/git-sync/status";
import { makeTempDir } from "./tmp";

describe("git-sync status store", () => {
  it("resolves concurrent status writes and leaves a parseable file with no temporary files", async () => {
    const stateDir = makeTempDir("obtc-git-status-");
    const store = new StatusStore(stateDir);
    await store.initialize();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.update({ lastError: `write ${index}` })),
    );
    expect(() => JSON.parse(readFileSync(store.path, "utf8"))).not.toThrow();
    expect(readdirSync(stateDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});
