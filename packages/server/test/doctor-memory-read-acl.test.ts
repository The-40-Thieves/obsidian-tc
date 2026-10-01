// memory.read-acl — would the folder read ACL hide a vault's memory folder from get_entity /
// query_entity_graph while memory entities exist? Mirrors doctor-capture-location.test.ts: a pure
// classifier over an already-resolved view, with the entity counts supplied by a probe.
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { type MemoryReadAclView, memoryReadAclCheck } from "../src/doctor/memory-read-acl";

const ctx = { serverVersion: "test" };
const acl = (over: Record<string, unknown>) =>
  new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], ...over });
const run = (view: MemoryReadAclView) => memoryReadAclCheck(view).run(ctx);
// n memory entities of `type` in vault "main" — what the --probe returns.
const counts =
  (n: number, entityType = "person") =>
  () =>
    Array.from({ length: n }, (_, i) => ({ vaultId: "main", entityType, name: `e${i}` }));

describe("memory.read-acl", () => {
  it("is ok on the shipped default (no ACL / no readPaths)", async () => {
    for (const a of [undefined, acl({})]) {
      const r = await run({
        vaults: [{ id: "main", memoryFolder: "memory", acl: a }],
        probe: counts(5),
      });
      expect(r.status).toBe("ok");
    }
  });

  it("is ok when readPaths names the memory folder", async () => {
    const r = await run({
      vaults: [{ id: "main", memoryFolder: "memory", acl: acl({ readPaths: ["memory/**"] }) }],
      probe: counts(5),
    });
    expect(r.status).toBe("ok");
  });

  it("WARNS when readPaths excludes the memory folder and entities exist, naming the fix", async () => {
    const r = await run({
      vaults: [{ id: "main", memoryFolder: "memory", acl: acl({ readPaths: ["public/**"] }) }],
      probe: counts(3),
    });
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toContain("main");
    expect(r.issues?.join(" ")).toContain("3");
    expect(r.remediation).toContain("memory/**");
  });

  it("WARNS under strictReadDefault with no readPaths", async () => {
    const r = await run({
      vaults: [{ id: "main", memoryFolder: "memory", acl: acl({ strictReadDefault: true }) }],
      probe: counts(1),
    });
    expect(r.status).toBe("warning");
  });

  it("counts only the entities the ACL actually hides (a partial readPaths)", async () => {
    const r = await run({
      vaults: [
        { id: "main", memoryFolder: "memory", acl: acl({ readPaths: ["memory/person/**"] }) },
      ],
      probe: () => [...counts(2, "person")(), ...counts(3, "tool")()],
    });
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toContain("3 of 5");
  });

  it("is ok when the folder is unreadable but NO entities exist", async () => {
    const r = await run({
      vaults: [{ id: "main", memoryFolder: "memory", acl: acl({ readPaths: ["public/**"] }) }],
      probe: counts(0),
    });
    expect(r.status).toBe("ok");
  });

  it("names the vault's own configured folder in the remediation", async () => {
    const r = await run({
      vaults: [{ id: "main", memoryFolder: "brain/mem", acl: acl({ readPaths: ["public/**"] }) }],
      probe: counts(2),
    });
    expect(r.status).toBe("warning");
    expect(r.remediation).toContain("brain/mem/**");
  });

  it("reports not-probed (ok) without a probe, and never fails", async () => {
    const r = await run({
      vaults: [{ id: "main", memoryFolder: "memory", acl: acl({ readPaths: ["public/**"] }) }],
    });
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("not probed");
  });
});
