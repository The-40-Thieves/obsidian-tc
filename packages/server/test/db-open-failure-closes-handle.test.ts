// A database file that is not a database fails on the FIRST pragma, after the adapter has already
// constructed the connection. The adapter must close it before rethrowing: left to GC it holds the
// file open, and on Windows that makes the file (and its directory) undeletable by a caller that has
// already handled the failure (cli-reflect-cachedb-guard's corrupt cache.db was the incident: EPERM
// on the fixture's directory, which the temp-dir gate then reported as a leak).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyConnectionPragmasOrClose } from "../src/db/apply-pragmas";
import { openNodeSqlite } from "../src/db/node-node-sqlite";
import { makeTempDir } from "./tmp";

afterEach(() => vi.restoreAllMocks());

function garbageDb(): string {
  const file = join(makeTempDir("obtc-open-fail-"), "cache.db");
  writeFileSync(file, "not a sqlite file, deliberately corrupt");
  return file;
}

describe("a failed open does not leak the connection", () => {
  it("openNodeSqlite closes the node:sqlite handle when the first pragma throws", async () => {
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    await expect(openNodeSqlite(garbageDb())).rejects.toThrow(/not a database/i);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("applyConnectionPragmasOrClose closes, then rethrows the ORIGINAL error even if close throws", () => {
    const boom = new Error("file is not a database");
    const close = vi.fn(() => {
      throw new Error("close failed too");
    });
    expect(() =>
      applyConnectionPragmasOrClose({ close }, () => {
        throw boom;
      }),
    ).toThrow(boom);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes nothing when every pragma succeeds", () => {
    const close = vi.fn();
    applyConnectionPragmasOrClose({ close }, () => {});
    expect(close).not.toHaveBeenCalled();
  });
});
