import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { issueElicitToken, verifyAndConsumeElicit } from "../src/elicit";
import { openMemoryDb } from "./helpers";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);

function freshDb() {
  const db = openMemoryDb();
  db.exec(schemaSql);
  return db;
}

describe("elicit token store", () => {
  it("issues a 32-char token, then verifies and consumes it exactly once", () => {
    const db = freshDb();
    const token = issueElicitToken(db, {
      vaultId: "v1",
      toolName: "delete_note",
      argsHash: "h1",
      caller: "c",
    });
    expect(token).toHaveLength(32);
    expect(verifyAndConsumeElicit(db, token, "h1", "v1", "c")).toBe(true);
    expect(verifyAndConsumeElicit(db, token, "h1", "v1", "c")).toBe(false); // single-use
  });

  it("rejects an unknown token", () => {
    expect(verifyAndConsumeElicit(freshDb(), "deadbeef", "h1", "v1", "c")).toBe(false);
  });

  it("rejects an expired token", () => {
    const db = freshDb();
    let t = 1_000_000;
    const now = () => t;
    const token = issueElicitToken(db, {
      vaultId: "v1",
      toolName: "x",
      argsHash: "h1",
      caller: null,
      ttlSeconds: 60,
      now,
    });
    t += 61_000; // past the 60s TTL
    expect(verifyAndConsumeElicit(db, token, "h1", "v1", null, now)).toBe(false);
  });

  it("rejects a wrong args_hash or wrong vault without consuming", () => {
    const db = freshDb();
    const token = issueElicitToken(db, {
      vaultId: "v1",
      toolName: "x",
      argsHash: "h1",
      caller: null,
    });
    expect(verifyAndConsumeElicit(db, token, "h2", "v1", null)).toBe(false); // wrong hash
    expect(verifyAndConsumeElicit(db, token, "h1", "v2", null)).toBe(false); // wrong vault
    expect(verifyAndConsumeElicit(db, token, "h1", "v1", null)).toBe(true); // not consumed by failures
  });

  it("rejects redemption by a different caller without consuming (H-3)", () => {
    const db = freshDb();
    const token = issueElicitToken(db, {
      vaultId: "v1",
      toolName: "delete_note",
      argsHash: "h1",
      caller: "alice",
    });
    expect(verifyAndConsumeElicit(db, token, "h1", "v1", "bob")).toBe(false); // wrong caller
    expect(verifyAndConsumeElicit(db, token, "h1", "v1", "alice")).toBe(true); // rightful caller
  });
});
