// Regression for the ACL fail-closed bypass (advisory A1): the M1 *enumeration* tools
// (list_tags, list_properties, find_orphans, vault_health_score, …) must honor
// strictReadDefault:true — no readPaths ⇒ deny — exactly like the canonical readable().
// Before the fix, four tool files (frontmatter/links/tags/graph-health) each had a local
// readable() that returned true on undefined readPaths, ignoring strictReadDefault and
// leaking whole-vault tags / frontmatter values / paths / link-graph under a fail-closed ACL.
import { describe, expect, it } from "vitest";
import { makeTestVault, type TestVault } from "./m1-helpers";

const FILES = {
  "secret/plan.md": "---\ntags: [topsecret]\nclassification: restricted\n---\n[[secret/detail]]\n",
  "secret/detail.md": "---\ntags: [topsecret]\n---\nbody\n",
  "lonely.md": "---\ntags: [topsecret]\n---\nno inbound links\n",
};
const STRICT = { strictReadDefault: true }; // no readPaths ⇒ everything denied

async function dataStr(
  v: TestVault,
  tool: string,
  input: Record<string, unknown>,
): Promise<string> {
  const r = await v.call(tool, { vault: "test", ...input });
  if (!r.ok) throw new Error(`${tool} failed: ${JSON.stringify(r.error)}`);
  return JSON.stringify(r.data);
}

describe("M1 enumeration tools honor strictReadDefault (advisory A1)", () => {
  // one representative tool per fixed file, with a distinctive vault-derived leak marker.
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["list_tags", {}, "topsecret"], // tags-tools.ts
    ["list_properties", {}, "classification"], // frontmatter-tools.ts
    ["find_orphans", {}, "lonely"], // links-tools.ts
  ];

  for (const [tool, input, leak] of cases) {
    it(`${tool} fails closed under strictReadDefault (no "${leak}" leak)`, async () => {
      const open = makeTestVault({ files: FILES });
      const strict = makeTestVault({ files: FILES, acl: STRICT });
      try {
        // open (no strict, no readPaths) still enumerates — the marker is present…
        expect(await dataStr(open, tool, input)).toContain(leak);
        // …but under strictReadDefault the whole vault is denied — no marker leaks.
        expect(await dataStr(strict, tool, input)).not.toContain(leak);
      } finally {
        open.cleanup();
        strict.cleanup();
      }
    });
  }

  it("vault_health_score sees an empty graph under strictReadDefault (graph-health-tools.ts)", async () => {
    const open = makeTestVault({ files: FILES });
    const strict = makeTestVault({ files: FILES, acl: STRICT });
    try {
      const o = await open.call("vault_health_score", { vault: "test" });
      const s = await strict.call("vault_health_score", { vault: "test" });
      expect(o.ok && s.ok).toBe(true);
      // With the fix, strict's readable note set is empty, so the health payload differs from
      // open's (0 notes vs 3). Before the fix both saw the whole vault and the payloads matched.
      if (o.ok && s.ok) expect(JSON.stringify(s.data)).not.toBe(JSON.stringify(o.data));
    } finally {
      open.cleanup();
      strict.cleanup();
    }
  });
});
