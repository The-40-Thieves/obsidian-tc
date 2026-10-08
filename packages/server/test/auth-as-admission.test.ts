// Admission of `GET /oauth/authorize` (design v2 section 8): the request is unauthenticated and parks a
// row, so one source, or one client, must not be able to fill the table for everyone, expired rows must
// not pile up, and the count-then-insert must be one write transaction.
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AdmissionLimits,
  createPending,
  MAX_PENDING_PER_CLIENT,
  MAX_PENDING_PER_SOURCE,
  MAX_PENDING_REQUESTS,
  PENDING_TTL_MS,
  type PendingRequest,
} from "../src/auth/as-grants";
import { provisionOauthDb } from "../src/db/provision";
import {
  authorize,
  CLIENT_ID,
  cleanupFlows,
  Jar,
  LOOPBACK_CLIENT,
  makeFlow,
  pkce,
  rows,
} from "./as-flow-harness";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const dirs: string[] = [];
const conns: Array<{ close: () => void }> = [];
afterEach(() => {
  cleanupFlows();
  for (const c of conns.splice(0)) c.close();
  for (const d of dirs.splice(0)) rmTemp(d);
});

const req = (clientId = CLIENT_ID): PendingRequest => ({
  clientId,
  redirectUri: "https://app.example/cb",
  scopes: ["read:notes"],
  resource: "https://mcp.example/mcp",
  codeChallenge: "c".repeat(43),
  state: null,
});
const LIMITS: AdmissionLimits = { global: 10, reserved: 2, perClient: 6, perSource: 3 };
const count = (db: { prepare: (s: string) => { get: () => unknown } }): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM auth_requests").get() as { n: number }).n;
const freshDb = () => {
  const db = openMemoryDb();
  provisionOauthDb(db, { version: "t" });
  return db;
};

describe("limits are stated, and ordered so a quota can bind before the pool does", () => {
  it("per source < per client < pool", () => {
    expect(MAX_PENDING_PER_SOURCE).toBeLessThan(MAX_PENDING_PER_CLIENT);
    expect(MAX_PENDING_PER_CLIENT).toBeLessThan(MAX_PENDING_REQUESTS);
  });
});

describe("one source cannot exhaust the pool", () => {
  it("over HTTP: a source that hit its quota gets 503 while another source still gets a pending request", async () => {
    const flow = await makeFlow();
    const { challenge } = pkce();
    const statuses: number[] = [];
    for (let i = 0; i < MAX_PENDING_PER_SOURCE + 5; i++) {
      statuses.push(
        (await authorize(flow, new Jar(), challenge, {}, { "x-test-ip": "203.0.113.7" })).status,
      );
    }
    expect(statuses.filter((s) => s === 303)).toHaveLength(MAX_PENDING_PER_SOURCE);
    expect(statuses.filter((s) => s === 503)).toHaveLength(5);

    const other = await authorize(flow, new Jar(), challenge, {}, { "x-test-ip": "203.0.113.8" });
    expect(other.status).toBe(303);
    expect(rows(flow, "SELECT 1 FROM auth_requests")).toHaveLength(MAX_PENDING_PER_SOURCE + 1);
  });

  it("the stored source is a hash, never the address", async () => {
    const flow = await makeFlow();
    await authorize(flow, new Jar(), pkce().challenge, {}, { "x-test-ip": "203.0.113.7" });
    const [row] = rows<{ source_hash: string | null }>(
      flow,
      "SELECT source_hash FROM auth_requests",
    );
    expect(row?.source_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows(flow, "SELECT * FROM auth_requests"))).not.toContain("203.0.113.7");
  });

  it("an unknown or loopback peer is not blamed on anyone: it is held to the client quota only", async () => {
    const flow = await makeFlow();
    const { challenge } = pkce();
    for (let i = 0; i < MAX_PENDING_PER_SOURCE + 2; i++) {
      expect((await authorize(flow, new Jar(), challenge)).status).toBe(303);
    }
    expect(
      rows<{ source_hash: string | null }>(flow, "SELECT source_hash FROM auth_requests")[0]
        ?.source_hash,
    ).toBeNull();
  });
});

describe("admission quotas (createPending)", () => {
  it("a client at its quota is refused, and another client is still admitted", () => {
    const db = freshDb();
    // Distinct sources, so only the client quota can bind.
    for (let i = 0; i < LIMITS.perClient; i++) {
      expect(createPending(db, req(), 1000, `10.0.0.${i}`, LIMITS), `request ${i}`).toBeDefined();
    }
    expect(createPending(db, req(), 1000, "10.0.1.1", LIMITS)).toBeUndefined();
    expect(createPending(db, req(LOOPBACK_CLIENT), 1000, "10.0.1.1", LIMITS)).toBeDefined();
  });

  it("the last `reserved` slots are kept for sources that hold nothing", () => {
    const db = freshDb();
    // Fill to global - reserved with sources that each hold one row (3 clients so no client quota binds).
    const clients = [CLIENT_ID, LOOPBACK_CLIENT, "third"];
    for (let i = 0; i < LIMITS.global - LIMITS.reserved; i++) {
      expect(createPending(db, req(clients[i % 3]), 1000, `10.0.0.${i}`, LIMITS)).toBeDefined();
    }
    // A source already holding a row may not take a reserved slot...
    expect(createPending(db, req(clients[0]), 1000, "10.0.0.0", LIMITS)).toBeUndefined();
    // ...a source holding none may, until the pool is truly full.
    expect(createPending(db, req(clients[0]), 1000, "10.9.9.1", LIMITS)).toBeDefined();
    expect(createPending(db, req(clients[1]), 1000, "10.9.9.2", LIMITS)).toBeDefined();
    expect(createPending(db, req(clients[2]), 1000, "10.9.9.3", LIMITS)).toBeUndefined();
    expect(count(db)).toBe(LIMITS.global);
  });
});

describe("expired rows are purged on admission", () => {
  it("a full table of expired rows admits a new request and leaves only that one, with no maintenance sweep", async () => {
    const flow = await makeFlow();
    const ins = flow.db.prepare(
      "INSERT INTO auth_requests (handle_hash, client_id, redirect_uri, scope, resource, code_challenge, created_at, expires_at) VALUES (?, 'c', 'r', 's', 'x', 'y', ?, ?)",
    );
    const t = flow.clock.t;
    for (let i = 0; i < MAX_PENDING_REQUESTS + 500; i++)
      ins.run(`old${i}`, t - 2 * PENDING_TTL_MS, t - 1);
    expect(rows(flow, "SELECT 1 FROM auth_requests")).toHaveLength(MAX_PENDING_REQUESTS + 500);

    const res = await authorize(flow, new Jar(), pkce().challenge);
    expect(res.status).toBe(303);
    expect(rows(flow, "SELECT 1 FROM auth_requests")).toHaveLength(1);
  });

  it("a row exactly at its expiry is already dead and does not count against the quota", () => {
    const db = freshDb();
    for (let i = 0; i < LIMITS.perSource; i++) createPending(db, req(), 1000, "10.0.0.1", LIMITS);
    expect(createPending(db, req(), 1000, "10.0.0.1", LIMITS)).toBeUndefined();
    expect(createPending(db, req(), 1000 + PENDING_TTL_MS, "10.0.0.1", LIMITS)).toBeDefined();
    expect(count(db)).toBe(1);
  });
});

describe("admission is one write transaction", () => {
  it("purge, count and insert all run inside a single BEGIN IMMEDIATE ... COMMIT", () => {
    const db = freshDb();
    const events: string[] = [];
    const exec = db.exec.bind(db);
    const prepare = db.prepare.bind(db);
    db.exec = (sql: string) => {
      events.push(sql);
      return exec(sql);
    };
    db.prepare = (sql: string) => {
      events.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      return prepare(sql);
    };
    expect(createPending(db, req(), 1000, "10.0.0.1", LIMITS)).toBeDefined();
    const begin = events.indexOf("BEGIN IMMEDIATE");
    const commit = events.indexOf("COMMIT");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    const between = events.slice(begin + 1, commit).join("|");
    expect(between).toMatch(/DELETE FROM auth_requests.*SELECT COUNT.*INSERT INTO auth_requests/);
    expect(events.slice(0, begin).filter((e) => /^(SELECT|INSERT|DELETE)/.test(e))).toEqual([]);
  });

  it("two connections to one file never admit more than the pool, however their calls interleave", () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const dir = makeTempDir("as-admit-");
    dirs.push(dir);
    const file = join(dir, "oauth.db");
    const a = new DatabaseSync(file);
    conns.push(a);
    provisionOauthDb(a, { version: "t" });
    const b = new DatabaseSync(file);
    conns.push(b);
    b.exec("PRAGMA busy_timeout = 2000");
    a.exec("PRAGMA busy_timeout = 2000");
    const limits: AdmissionLimits = { global: 8, reserved: 0, perClient: 100, perSource: 100 };
    let admitted = 0;
    for (let i = 0; i < 20; i++) {
      const db = i % 2 === 0 ? a : b;
      if (createPending(db, req(), 1000, `10.0.0.${i}`, limits) !== undefined) admitted++;
    }
    expect(admitted).toBe(limits.global);
    expect(count(a)).toBe(limits.global);
  });

  it("a writer holding the lock makes admission wait or fail; it never counts outside the lock", () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const dir = makeTempDir("as-admit-");
    dirs.push(dir);
    const file = join(dir, "oauth.db");
    const a = new DatabaseSync(file);
    conns.push(a);
    provisionOauthDb(a, { version: "t" });
    const b = new DatabaseSync(file);
    conns.push(b);
    b.exec("PRAGMA busy_timeout = 0");
    a.exec("BEGIN IMMEDIATE");
    expect(() => createPending(b, req(), 1000, "10.0.0.1", LIMITS)).toThrow(/locked|busy/i);
    a.exec("ROLLBACK");
    expect(createPending(b, req(), 1000, "10.0.0.1", LIMITS)).toBeDefined();
  });
});
