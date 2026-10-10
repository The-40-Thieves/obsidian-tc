// The whole-vault link scans were made cooperative (they yield the event loop between notes). This
// pins that the answers did not move: EXPECTED was captured from the synchronous implementation on
// the commit before the change, and every call below must still return it byte for byte.
// Regenerate only on an intentional output change: UPDATE_SCAN_EXPECTED=1 vitest run <this file>.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCAN_CALLS, scanFixtureFiles } from "./fixtures/scan-yield-vault";
import { makeTestVault } from "./m1-helpers";

const EXPECTED = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "scan-yield-before.json",
);

describe("whole-vault scans: cooperative output equals the synchronous output", () => {
  it("returns the pre-change bytes for every scan tool", { timeout: 60_000 }, async () => {
    const v = makeTestVault({ files: scanFixtureFiles(), wikiFolder: "wiki" });
    try {
      const got: Record<string, string> = {};
      for (const [tool, input] of SCAN_CALLS) {
        const r = await v.call(tool, { vault: "test", ...input });
        expect(r.ok, `${tool} ${JSON.stringify(input)}`).toBe(true);
        got[`${tool} ${JSON.stringify(input)}`] = JSON.stringify(r.ok ? r.data : r);
      }
      if (process.env.UPDATE_SCAN_EXPECTED === "1")
        writeFileSync(EXPECTED, `${JSON.stringify(got, null, 1)}\n`);
      const expected = JSON.parse(readFileSync(EXPECTED, "utf8")) as Record<string, string>;
      expect(Object.keys(expected).length).toBe(SCAN_CALLS.length);
      expect(got).toEqual(expected);
      // The fixture really exercises the branches: cycles, orphans and dangling links are non-empty.
      const health = JSON.parse(got[`vault_health_score ${JSON.stringify({})}`] as string);
      expect(health.metrics.cycles).toBeGreaterThan(0);
      expect(health.metrics.orphans).toBeGreaterThan(0);
      expect(health.metrics.unresolved_links).toBeGreaterThan(0);
      expect(health.warnings?.length).toBeGreaterThan(0);
    } finally {
      v.cleanup();
    }
  });
});
