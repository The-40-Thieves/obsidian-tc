// THE-627: which client software made the call, read from per-request MCP `_meta`.
//
// The assertion that matters most is not "it parses a well-formed value" — it is that every absent
// or malformed path records NULL and never a placeholder. A literal "unknown" in the column would be
// indistinguishable from a client that genuinely reports that name, which is a failure encoded as a
// valid domain value (the THE-613 shape). So the round-trip below asserts on the DB row, not on the
// extractor's return.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { CLIENT_INFO_META_KEY, extractClientInfo } from "../src/mcp/client-info";
import { getSession, insertSession } from "../src/workspace/sessions";
import { openMemoryDb } from "./helpers";

const meta = (info: unknown) => ({ [CLIENT_INFO_META_KEY]: info });

describe("extractClientInfo — untrusted `_meta` parsing", () => {
  it("uses the reverse-DNS key the 2026-07-28 spec assigns", () => {
    // Pinned explicitly: the whole value of a namespaced key is that it is agreed, and reading the
    // wrong one would silently record nothing forever while looking implemented.
    expect(CLIENT_INFO_META_KEY).toBe("io.modelcontextprotocol/clientInfo");
    expect(extractClientInfo(meta({ name: "claude-desktop", version: "1.2.0" }))).toEqual({
      name: "claude-desktop",
      version: "1.2.0",
    });
  });

  it("takes a name without a version — version is optional in the spec", () => {
    expect(extractClientInfo(meta({ name: "cursor" }))).toEqual({ name: "cursor" });
  });

  it("returns undefined when absent — the NORMAL case, not an error", () => {
    // No client sends this key under the current spec, so this branch is what runs in production
    // today. It has to be cheap and silent.
    expect(extractClientInfo(undefined)).toBeUndefined();
    expect(extractClientInfo(null)).toBeUndefined();
    expect(extractClientInfo({})).toBeUndefined();
    expect(extractClientInfo({ traceparent: "00-abc-def-01" })).toBeUndefined();
    expect(extractClientInfo("not an object")).toBeUndefined();
  });

  it("DROPS a version with no name — a nameless version identifies nothing", () => {
    expect(extractClientInfo(meta({ version: "1.2.0" }))).toBeUndefined();
  });

  it("rejects non-string and empty fields rather than storing them", () => {
    expect(extractClientInfo(meta({ name: 42 }))).toBeUndefined();
    expect(extractClientInfo(meta({ name: "" }))).toBeUndefined();
    expect(extractClientInfo(meta({ name: null }))).toBeUndefined();
    expect(extractClientInfo(meta("a string, not an object"))).toBeUndefined();
    // A bad version does not poison a good name — the identity survives, the junk is dropped.
    expect(extractClientInfo(meta({ name: "cursor", version: 7 }))).toEqual({ name: "cursor" });
  });

  it("DROPS an over-long value instead of truncating it", () => {
    // These reach a DB column, so an unbounded value is a storage problem. Truncating is worse than
    // dropping: a truncated version string is indistinguishable from a real one.
    const long = "x".repeat(129);
    expect(extractClientInfo(meta({ name: long }))).toBeUndefined();
    expect(extractClientInfo(meta({ name: "ok", version: long }))).toEqual({ name: "ok" });
    // A value AT the limit is kept — otherwise "drops long values" would pass by dropping everything.
    expect(extractClientInfo(meta({ name: "x".repeat(128) }))?.name).toHaveLength(128);
  });
});

describe("session row round-trip (THE-627)", () => {
  const freshDb = (): Database => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    return db;
  };
  const base = {
    id: "s1",
    vaultId: "v1",
    caller: "c",
    startedAt: 1_000,
    tracePath: join(mkdtempSync(join(tmpdir(), "tc-sess-")), "s1.jsonl"),
  };

  it("stores the client identity when the request carried one", () => {
    const db = freshDb();
    insertSession(db, { ...base, clientInfo: { name: "claude-desktop", version: "1.2.0" } });
    expect(getSession(db, "s1")).toMatchObject({
      client_name: "claude-desktop",
      client_version: "1.2.0",
    });
  });

  it("records NULL — never a placeholder — when the client sent nothing", () => {
    // The whole point. `toBeNull` and not `toBeFalsy`: "unknown" or "" would both pass a laxer
    // assertion and both destroy the ability to tell "did not say" from "said this".
    const db = freshDb();
    insertSession(db, base);
    const row = getSession(db, "s1");
    expect(row?.client_name).toBeNull();
    expect(row?.client_version).toBeNull();
  });

  it("records a NULL version beside a real name", () => {
    const db = freshDb();
    insertSession(db, { ...base, clientInfo: { name: "cursor" } });
    const row = getSession(db, "s1");
    expect(row?.client_name).toBe("cursor");
    expect(row?.client_version).toBeNull();
  });

  it("leaves the caller-supplied metadata_json untouched — observation and declaration stay apart", () => {
    // These are two different kinds of claim: `metadata` is whatever the caller passed to
    // start_session, `clientInfo` is what the server observed on the transport. Folding one into the
    // other would make them indistinguishable downstream, which is why this got its own columns
    // rather than a key inside metadata_json.
    const db = freshDb();
    insertSession(db, {
      ...base,
      metadata: { topic: "research" },
      clientInfo: { name: "claude-desktop", version: "1.2.0" },
    });
    const row = getSession(db, "s1");
    expect(JSON.parse(row?.metadata_json ?? "{}")).toEqual({ topic: "research" });
    expect(row?.client_name).toBe("claude-desktop");
  });
});
