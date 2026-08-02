// THE-691 / THE-694 (security): the query router's rare-term signal must not leak the existence —
// or the document frequency — of terms that appear only in notes the caller cannot read.
//
// `routeQuery` emits `rare-term:<token>(df=<n>)` when a token's document frequency lands in
// [1, rareDfMax], and `route.signals` is returned VERBATIM to callers from five tool sites —
// vault_graph_search, knowledge_search, vault_context, and two paths in reflect. `termDf` originally
// counted matching rows with NO read ACL, which made every one of those tools a content-membership
// oracle for any caller holding `read:notes`.
//
// THE-691 closed the VALUE channel by paging until the readable count was exact. THE-694 then
// measured what remained. On a live snapshot with a restricted ACL, both queries answering 0:
//
//   a term present ONLY in denied notes (1,504 hidden matches) -> mean 3.381 ms
//   a term absent from the vault entirely                      -> mean 0.047 ms
//
// 72x on means, 77x on medians, non-overlapping distributions. Latency still correlated with how
// much denied content matched a caller-supplied token, and no in-SQL filter removes that: joining a
// materialized permitted set plans as `SCAN chunk_fts VIRTUAL TABLE` plus a per-row membership
// probe, so work tracks TOTAL matches however the predicate is written.
//
// So the probe is no longer issued at all for a restricted caller. The paged scan is DELETED, not
// filtered. The assertion that matters is unchanged and now holds more strongly: a term present
// only in an unreadable note must be indistinguishable from a term absent entirely — and it is now
// indistinguishable in TIME as well as in value, because no query runs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { routeQuery } from "../src/search/router";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";
const readable = (p: string): boolean => !p.startsWith("09-private/");

/** True once per run: FTS5 is compiled into this runtime. Asserted, not silently skipped — every
 *  test here returned early when FTS5 was missing, so the whole file could pass having exercised no
 *  assertion at all. A security suite that is green because it ran nothing is worse than no suite:
 *  it reports the property as held. CI compiles FTS5, so requiring it is the honest contract. */
function requireFts(db: Database): Database {
  if (!ensureChunkFts(db)) {
    throw new Error(
      "FTS5 unavailable — THE-691/THE-694's assertions cannot run. Refusing to pass vacuously.",
    );
  }
  return db;
}

function dbWith(rows: Array<{ id: string; path: string; content: string }>): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  const ins = db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, '0', '[]', ?, ?, 1, 0, 0)",
  );
  for (const r of rows) ins.run(r.id, VAULT, r.path, r.content, `h-${r.id}`);
  return requireFts(db);
}

const hidden = (n: number, term = "zarquon") =>
  Array.from({ length: n }, (_, i) => ({
    id: `h${i}`,
    path: `09-private/h${i}.md`,
    content: term,
  }));

describe("THE-691/THE-694: routeQuery must not leak unreadable term existence", () => {
  it("a term present ONLY in an unreadable note is indistinguishable from an absent term", () => {
    const db = dbWith([{ id: "p", path: "09-private/secret.md", content: "zarquon classified" }]);

    const hiddenTerm = routeQuery(db, VAULT, "zarquon", { isReadable: readable });
    const absent = routeQuery(db, VAULT, "notpresentanywhere", { isReadable: readable });

    // The whole point: same class, same signals, nothing to compare.
    expect(hiddenTerm.signals).toEqual(absent.signals);
    expect(hiddenTerm.class).toBe(absent.class);
    expect(hiddenTerm.signals.join(" ")).not.toContain("zarquon");
  });

  it("proves the oracle is real when the ACL is omitted — this test is not vacuous", () => {
    // No ACL at all means nothing to protect, so the whole-vault count is emitted by design. This
    // documents the exact shape of the leak the ACL branch closes, and keeps the assertion above
    // from passing merely because the signal is never emitted under any conditions.
    const db = dbWith([{ id: "p", path: "09-private/secret.md", content: "zarquon classified" }]);

    const leaked = routeQuery(db, VAULT, "zarquon");
    expect(leaked.signals.join(" ")).toContain("zarquon");
    expect(leaked.signals.join(" ")).toContain("df=1");
  });

  it("a rare term still routes lexical for an UNRESTRICTED caller — the fix does not kill the feature", () => {
    const db = dbWith([{ id: "v", path: "00-public.md", content: "zarquon visible" }]);

    const r = routeQuery(db, VAULT, "zarquon", { isReadable: readable, readUnrestricted: true });
    expect(r.class).toBe("lexical");
    expect(r.signals.join(" ")).toContain("zarquon");
  });

  it("a RESTRICTED caller never routes lexical, even on a term they can read", () => {
    // THE-694's deliberate cost, pinned so it is a decision rather than a regression: a restricted
    // caller loses rare-term routing entirely. That is a RANKING optimization, not correctness —
    // they fall through to `standard`, the same path they took before the router existed. Buying
    // it back would mean issuing the probe, which is the disclosure.
    const db = dbWith([{ id: "v", path: "00-public.md", content: "zarquon visible" }]);

    const r = routeQuery(db, VAULT, "zarquon", { isReadable: readable, readUnrestricted: false });
    expect(r.class).toBe("standard");
    expect(r.signals.join(" ")).not.toContain("zarquon");
  });

  it("FAILS CLOSED: an ACL with no explicit readUnrestricted does not probe", () => {
    // The dangerous default would be the other way round. A caller site that threads `isReadable`
    // but forgets `readUnrestricted` must lose the optimization, never the protection.
    const db = dbWith([{ id: "v", path: "00-public.md", content: "zarquon visible" }]);

    const r = routeQuery(db, VAULT, "zarquon", { isReadable: readable });
    expect(r.class).toBe("standard");
    expect(r.signals.join(" ")).not.toContain("zarquon");
  });
});

describe("THE-694: hidden volume cannot reach a restricted caller at all", () => {
  // These replace THE-691's paging-boundary cases. The paged scan they pinned no longer exists —
  // its correctness was never the problem, its COST was, because the cost was observable. What
  // survives is the property those tests were ultimately protecting, stated directly.

  it("hidden rows cannot change routing for an otherwise identical readable corpus", () => {
    const visible = [{ id: "vis", path: "00-visible.md", content: "zarquon" }];
    const bare = routeQuery(dbWith(visible), VAULT, "zarquon", { isReadable: readable });
    const buried = routeQuery(dbWith([...hidden(400), ...visible]), VAULT, "zarquon", {
      isReadable: readable,
    });
    expect(buried.class).toBe(bare.class);
    expect(buried.signals).toEqual(bare.signals);
  });

  it("400 hidden matches and 0 hidden matches produce the same decision and signals", () => {
    // The non-interference statement at its strongest: the readable corpus is EMPTY in both, so any
    // difference at all would be attributable purely to denied content.
    const none = routeQuery(dbWith([]), VAULT, "zarquon", { isReadable: readable });
    const many = routeQuery(dbWith(hidden(400)), VAULT, "zarquon", { isReadable: readable });
    expect(many.class).toBe(none.class);
    expect(many.signals).toEqual(none.signals);
  });

  it("issues NO chunk_fts statement for a restricted caller, whatever the hidden volume", () => {
    // The mechanism, asserted directly rather than inferred from a timing measurement (which would
    // be circular — timing is the thing under test). Zero statements is why the channel is closed
    // rather than merely narrowed: there is no work whose duration could vary.
    const db = dbWith(hidden(400));
    let ftsStatements = 0;
    const raw = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (sql.includes("chunk_fts")) ftsStatements++;
      return raw(sql);
    };

    routeQuery(db, VAULT, "zarquon", { isReadable: readable });

    expect(ftsStatements).toBe(0);
  });
});
