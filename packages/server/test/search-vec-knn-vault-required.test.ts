import { describe, expect, it } from "vitest";
import { vecKnn } from "../src/search/vec";

describe("vecKnn vault scope", () => {
  it("requires vaultId at compile time: an unscoped KNN would search every vault's vectors", () => {
    const db = null as unknown as Parameters<typeof vecKnn>[0];
    // @ts-expect-error vaultId is required; this typecheck fails if the parameter is optional again
    const unscoped = () => vecKnn(db, [0], 1);
    expect(typeof unscoped).toBe("function");
  });
});
