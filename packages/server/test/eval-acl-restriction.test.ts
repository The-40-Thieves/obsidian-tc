import { describe, expect, it } from "vitest";
import { restrictQuery } from "../eval/run";
import { FolderAcl, makeIndexReadable } from "../src/acl";

const q = {
  id: "q1",
  query_text: "x",
  seed_domain: "a",
  target_domain: "b",
  seed_paths: ["02-projects/Seed.md"],
  target_paths: ["02-projects/Hit.md", "05-creative/Secret.md"],
  bridge_paths: ["05-creative/Bridge.md", "02-projects/Bridge2.md"],
  description: "",
};

/** The predicate the eval installs — built the way production builds it, not hand-rolled. */
function readable(allow: string): (rel: string) => boolean {
  const acl = new FolderAcl({
    readOnly: false,
    defaultScopes: [],
    rules: [],
    readPaths: [allow],
    strictReadDefault: true,
  } as never);
  return makeIndexReadable(acl, new Map())("main");
}

describe("THE-699: the eval harness can vary ACL state", () => {
  it("the production ACL factory actually restricts — the predicate is not a constant", () => {
    const isReadable = readable("02-projects/**");
    // Non-vacuity FIRST. The whole defect was a predicate that answered true for everything, so a
    // test that only checks the allowed side would pass against `() => true` and prove nothing.
    expect(isReadable("02-projects/Hit.md")).toBe(true);
    expect(isReadable("05-creative/Secret.md")).toBe(false);
  });

  it("restricts the GROUND TRUTH by the same predicate, and reports what it dropped", () => {
    const isReadable = readable("02-projects/**");
    const r = restrictQuery(q, isReadable);
    // Unreadable expected paths must leave the qrels, or recall collapses for a reason that has
    // nothing to do with retrieval quality.
    expect(r.query.target_paths).toEqual(["02-projects/Hit.md"]);
    expect(r.query.bridge_paths).toEqual(["02-projects/Bridge2.md"]);
    expect(r.droppedTargets).toBe(1);
    expect(r.droppedBridges).toBe(1);
  });

  it("an unrestricted predicate drops nothing — the two regimes are distinguishable", () => {
    const r = restrictQuery(q, () => true);
    expect(r.droppedTargets).toBe(0);
    expect(r.droppedBridges).toBe(0);
    expect(r.query.target_paths).toHaveLength(2);
  });
});
