// THE-935 (GH #878): config's db.busyTimeoutMs must reach every connectionPragmas() call site —
// each of the three DB adapters forwards its own busyTimeoutMs parameter through to
// connectionPragmas(busyTimeoutMs) rather than calling it bare, which would silently discard the
// configured value and fall back to DEFAULT_BUSY_TIMEOUT_MS. A NON-DEFAULT N is asserted (12345,
// never a real default) so a regression that drops the parameter cannot pass by coincidence.
//
// bun-sqlite.ts's adapter cannot be constructed here: it dynamically imports "bun:sqlite", which
// only resolves under the Bun runtime, and this suite runs under Node (see CLAUDE.md). Verified by
// an inventory-style source scan instead — see the last test below.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "../src/db/node-better-sqlite3";
import { openNodeSqlite } from "../src/db/node-node-sqlite";
import { rmTemp } from "./tmp";

const NON_DEFAULT_MS = 12345;

// better-sqlite3's native binding is not built in every local env (mirrors db-baseline.test.ts) —
// probe once and skip the adapter integration test when it cannot load.
let bsqlOk = true;
try {
  const d = await openBetterSqlite3(":memory:");
  d.close?.();
} catch {
  bsqlOk = false;
}

describe.skipIf(!bsqlOk)("openBetterSqlite3 threads busyTimeoutMs (THE-935)", () => {
  it("applies the configured value, not the default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otc-bsql-busy-"));
    try {
      const db = await openBetterSqlite3(join(dir, "t.db"), NON_DEFAULT_MS);
      expect((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(
        NON_DEFAULT_MS,
      );
      db.close?.();
    } finally {
      rmTemp(dir);
    }
  });
});

describe("openNodeSqlite threads busyTimeoutMs (THE-935)", () => {
  it("applies the configured value, not the default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otc-nsql-busy-"));
    try {
      const db = await openNodeSqlite(join(dir, "t.db"), NON_DEFAULT_MS);
      expect((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(
        NON_DEFAULT_MS,
      );
      db.close?.();
    } finally {
      rmTemp(dir);
    }
  });
});

describe("openBunSqlite threads busyTimeoutMs (THE-935, inventory)", () => {
  it("forwards its busyTimeoutMs parameter into connectionPragmas(), never calls it bare", () => {
    const src = readFileSync(join(__dirname, "..", "src", "db", "bun-sqlite.ts"), "utf8");
    expect(src).toContain("openBunSqlite(path: string, busyTimeoutMs?: number)");
    expect(src).toContain("connectionPragmas(busyTimeoutMs)");
    expect(src).not.toMatch(/connectionPragmas\(\)/);
  });
});
