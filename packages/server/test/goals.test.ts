// THE-633 — stated goals.
//
// The interesting tests here are not the CRUD ones. They are the four constraints the membrane
// decision put on this table, because each is the thing that makes it safe to keep user-authored
// intent in the low-trust experiential store:
//
//   1. vault_id from the first migration (the neighbouring precedent shipped without it and needed
//      a rebuild — THE-710 / 20260803_001, landed immediately before this)
//   2. `source` CHECK-pinned to stated provenance, so an inferred write is a CONSTRAINT VIOLATION
//   3. no inference path can write goals — a grep gate, the technique graph-analytics.test.ts uses
//   4. authority monotonicity: open -> terminal, once, never back
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import * as goalsModule from "../src/experiential/goals";
import { closeGoal, expireOverdueGoals, listGoals, setGoal } from "../src/experiential/goals";
import { openMemoryDb } from "./helpers";

const sql = (p: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${p}`, import.meta.url)), "utf8");
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const V1 = "vault-one";
const V2 = "vault-two";

function db0(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260803_002", sql: sql("20260803_002_goals.sql") }]);
  return db;
}

const add = (db: Database, id: string, over: Partial<Parameters<typeof setGoal>[1]> = {}) =>
  setGoal(db, { id, vaultId: V1, text: `goal ${id}`, createdAt: NOW, ...over });

describe("goals — the store", () => {
  it("records a stated goal as open with no closed_at", () => {
    const db = db0();
    const g = add(db, "g1");
    expect(g).toMatchObject({ status: "open", source: "stated", closed_at: null, vault_id: V1 });
    expect(listGoals(db, V1)).toHaveLength(1);
  });

  it("lists OPEN goals by default — a forgotten filter shows intent, not a graveyard", () => {
    const db = db0();
    add(db, "open-one");
    add(db, "done-one");
    closeGoal(db, { id: "done-one", vaultId: V1, status: "completed", closedAt: NOW + 1 });
    expect(listGoals(db, V1).map((g) => g.id)).toEqual(["open-one"]);
    expect(listGoals(db, V1, { status: "any" })).toHaveLength(2);
    expect(listGoals(db, V1, { status: "completed" }).map((g) => g.id)).toEqual(["done-one"]);
  });

  it("is vault-partitioned — constraint 1, the whole reason THE-710 landed first", () => {
    const db = db0();
    add(db, "mine", { vaultId: V1 });
    add(db, "theirs", { vaultId: V2 });
    expect(listGoals(db, V1).map((g) => g.id)).toEqual(["mine"]);
    expect(listGoals(db, V2).map((g) => g.id)).toEqual(["theirs"]);
    // And a close cannot reach across the partition.
    expect(closeGoal(db, { id: "theirs", vaultId: V1, status: "completed", closedAt: NOW })).toBe(
      null,
    );
    expect(listGoals(db, V2, { status: "open" })).toHaveLength(1);
  });
});

describe("goals — constraint 2: provenance is enforced by the DATABASE", () => {
  it("rejects a non-stated source at the constraint, not by convention", () => {
    // The decision's wording: "an inferred write is a constraint violation rather than a
    // convention". This test IS that claim — it writes raw SQL, bypassing setGoal entirely, which
    // is exactly what a future inference path would look like if someone added one.
    const db = db0();
    expect(() =>
      db
        .prepare(
          "INSERT INTO goals (id, vault_id, text, status, source, created_at) VALUES ('x', ?, 't', 'open', 'inferred', ?)",
        )
        .run(V1, NOW),
    ).toThrow();
  });

  it("rejects an incoherent terminal row: closed status with no closed_at", () => {
    const db = db0();
    expect(() =>
      db
        .prepare(
          "INSERT INTO goals (id, vault_id, text, status, source, created_at, closed_at) VALUES ('x', ?, 't', 'completed', 'stated', ?, NULL)",
        )
        .run(V1, NOW),
    ).toThrow();
  });

  it("rejects an open row that carries a closed_at", () => {
    const db = db0();
    expect(() =>
      db
        .prepare(
          "INSERT INTO goals (id, vault_id, text, status, source, created_at, closed_at) VALUES ('x', ?, 't', 'open', 'stated', ?, ?)",
        )
        .run(V1, NOW, NOW),
    ).toThrow();
  });

  it("rejects a status outside the enumerated set", () => {
    const db = db0();
    expect(() =>
      db
        .prepare(
          "INSERT INTO goals (id, vault_id, text, status, source, created_at, closed_at) VALUES ('x', ?, 't', 'paused', 'stated', ?, ?)",
        )
        .run(V1, NOW, NOW),
    ).toThrow();
  });
});

describe("goals — constraint 4: authority monotonicity", () => {
  it("closes once; a second close changes nothing and reports it", () => {
    const db = db0();
    add(db, "g");
    const first = closeGoal(db, { id: "g", vaultId: V1, status: "completed", closedAt: NOW + 5 });
    expect(first).toMatchObject({ status: "completed", closed_at: NOW + 5 });
    // The second attempt must not silently succeed, and must not overwrite the first verdict.
    const second = closeGoal(db, { id: "g", vaultId: V1, status: "abandoned", closedAt: NOW + 9 });
    expect(second).toBe(null);
    expect(listGoals(db, V1, { status: "any" })[0]).toMatchObject({
      status: "completed",
      closed_at: NOW + 5,
    });
  });

  it("reports null for a goal that does not exist, rather than a hollow success", () => {
    const db = db0();
    expect(closeGoal(db, { id: "nope", vaultId: V1, status: "completed", closedAt: NOW })).toBe(
      null,
    );
  });

  it("there is no reopen: the store exports no verb that returns a closed goal to open", () => {
    // A structural assertion, not a behavioural one. Reopening is absent BY DESIGN — a system that
    // quietly reopened a goal the user completed is the low-confidence mutation the constraint
    // forbids. If someone adds one, this must be changed deliberately.
    expect(Object.keys(goalsModule).sort()).toEqual([
      "closeGoal",
      "expireOverdueGoals",
      "listGoals",
      "setGoal",
    ]);
  });
});

describe("goals — expiry is a state, not a delete", () => {
  it("marks overdue OPEN goals expired and keeps the row", () => {
    const db = db0();
    add(db, "overdue", { targetDate: NOW - DAY });
    add(db, "future", { targetDate: NOW + DAY });
    add(db, "no-deadline");
    expect(expireOverdueGoals(db, NOW)).toBe(1);
    const all = listGoals(db, V1, { status: "any" });
    expect(all).toHaveLength(3); // nothing deleted
    expect(all.find((g) => g.id === "overdue")).toMatchObject({
      status: "expired",
      closed_at: NOW,
    });
    expect(
      listGoals(db, V1)
        .map((g) => g.id)
        .sort(),
    ).toEqual(["future", "no-deadline"]);
  });

  it("never re-closes an already-terminal goal, so a user verdict survives the sweep", () => {
    // The asymmetry that matters: `expired` is the system's verdict about a deadline, `abandoned`
    // is the user's about the goal. A sweep that overwrote the second with the first would destroy
    // the distinction every consumer needs.
    const db = db0();
    add(db, "g", { targetDate: NOW - DAY });
    closeGoal(db, { id: "g", vaultId: V1, status: "abandoned", closedAt: NOW - 10 });
    expect(expireOverdueGoals(db, NOW)).toBe(0);
    expect(listGoals(db, V1, { status: "any" })[0]).toMatchObject({
      status: "abandoned",
      closed_at: NOW - 10,
    });
  });
});

describe("goals — constraint 3: no inference path can write a goal", () => {
  it("nothing under experiential/ that infers ever imports the goals store", () => {
    // The same technique graph-analytics.test.ts uses to prove analytics never reaches ranking.
    // reflect.ts is the inference path: it asks a judge to propose typed deltas from episode
    // evidence. If it ever gains a goals write, stated intent stops being stated — which is the
    // single assumption the membrane decision rests on.
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const files = execFileSync("git", ["ls-files", "packages/server/src/experiential/*.ts"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      // The store itself is allowed to mention itself.
      .filter((f) => !f.endsWith("/goals.ts"))
      // THE-636: the derived-plane export/restore bundle reads and writes goals for backup and
      // migration — it is NOT an inference path. Two structural guarantees keep the membrane intact
      // regardless of this proxy: (1) the bundle writes goals only via `INSERT INTO goals` with the
      // row's own `source` value carried verbatim, and (2) the goals table's `source CHECK
      // (source IN ('stated'))` (20260803_002) rejects any non-stated write at the DB layer — so an
      // imported goal cannot acquire inferred provenance even if a crafted bundle tried. The
      // constraint this gate protects — reflect.ts (the judge-driven inference path) never writing a
      // goal — is unaffected; the "goals store imports no gateway/judge" test below is its companion.
      .filter((f) => !f.endsWith("/context-bundle.ts") && !f.endsWith("/context-bundle-schema.ts"));
    // Non-vacuity floor: an empty scan must not pass. `git ls-files` sees TRACKED files only, so a
    // brand-new untracked inference module would escape this gate until it is added — the same
    // limitation the precedent carries, stated so it is not mistaken for coverage it lacks.
    expect(files.length).toBeGreaterThan(5);
    const offenders = files.filter((f) => {
      const src = readFileSync(join(root, f), "utf8");
      return src.includes("experiential/goals") || /\bfrom\s+"\.\/goals"/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("the goals store imports no gateway or judge, so it cannot infer even by accident", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/experiential/goals.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+"\.\.\/plane\/gateway"/);
    expect(src).not.toMatch(/GatewayRoles|judge\(/);
    // And provenance is hard-coded rather than parameterised, so no caller can request another.
    expect(src).toContain("'stated'");
  });
});
