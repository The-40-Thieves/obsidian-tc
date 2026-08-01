// THE-691 (security): the query router's rare-term signal must not leak the existence — or the
// document frequency — of terms that appear only in notes the caller cannot read.
//
// `routeQuery` emits `rare-term:<token>(df=<n>)` when a token's document frequency lands in
// [1, rareDfMax]. `termDf` counted matching rows in the FTS index with NO read ACL, and
// `route.signals` is returned VERBATIM to callers from five tool sites — vault_graph_search,
// knowledge_search, vault_context, and two paths in reflect.
//
// That made every one of those tools a content-membership oracle for any caller holding
// `read:notes`: guess a term, read `route` in an ordinary successful response, and learn both
// whether the word occurs in the vault and in how many chunks. Not a path oracle — a CONTENT one.
// Confirming a name, a codeword, or a medical term inside a denied folder is precisely what the
// folder ACL exists to prevent.
//
// The assertion that matters is the INDISTINGUISHABILITY one: a term present only in an unreadable
// note must produce the same signals as a term absent from the vault entirely. Checking that an
// `isReadable` argument is threaded would prove nothing — the leak was in a COUNT, and counts
// survive filters applied too late.
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
      "FTS5 unavailable — THE-691's assertions cannot run. Refusing to pass vacuously.",
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

describe("THE-691: routeQuery must not leak unreadable term existence", () => {
  it("a term present ONLY in an unreadable note is indistinguishable from an absent term", () => {
    const db = dbWith([{ id: "p", path: "09-private/secret.md", content: "zarquon classified" }]);

    const hidden = routeQuery(db, VAULT, "zarquon", { isReadable: readable });
    const absent = routeQuery(db, VAULT, "notpresentanywhere", { isReadable: readable });

    // The whole point: same class, same signals, nothing to compare.
    expect(hidden.signals).toEqual(absent.signals);
    expect(hidden.class).toBe(absent.class);
    expect(hidden.signals.join(" ")).not.toContain("zarquon");
  });

  it("proves the oracle is real when the ACL is omitted — this test is not vacuous", () => {
    // Without isReadable the old behaviour stands, so the assertion above is testing something.
    // Also documents the exact shape of the leak for anyone reading this later.
    const db = dbWith([{ id: "p", path: "09-private/secret.md", content: "zarquon classified" }]);

    const leaked = routeQuery(db, VAULT, "zarquon");
    expect(leaked.signals.join(" ")).toContain("zarquon");
    expect(leaked.signals.join(" ")).toContain("df=1");
  });

  it("a READABLE rare term still routes lexical — the fix must not disable the feature", () => {
    const db = dbWith([{ id: "v", path: "00-public.md", content: "zarquon visible" }]);

    const r = routeQuery(db, VAULT, "zarquon", { isReadable: readable });
    expect(r.class).toBe("lexical");
    expect(r.signals.join(" ")).toContain("zarquon");
  });

  it("counts only READABLE occurrences, so the df value cannot be read off unreadable notes", () => {
    // Three copies of the term, two hidden. The reported df must be 1, not 3 — otherwise the
    // NUMBER still betrays how much unreadable content matches.
    const db = dbWith([
      { id: "a", path: "09-private/a.md", content: "zarquon" },
      { id: "b", path: "09-private/b.md", content: "zarquon" },
      { id: "c", path: "00-public.md", content: "zarquon" },
    ]);

    const r = routeQuery(db, VAULT, "zarquon", { isReadable: readable });
    expect(r.signals.join(" ")).toContain("df=1");
    expect(r.signals.join(" ")).not.toContain("df=3");
  });

  it("a term hidden across MANY unreadable notes does not route lexical either", () => {
    // df over the whole corpus would be 8 — outside the rare window — while the readable df is 0.
    // Both the signal AND the routing decision must follow what this caller can see.
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      path: `09-private/n${i}.md`,
      content: "zarquon",
    }));
    const db = dbWith(rows);

    const r = routeQuery(db, VAULT, "zarquon", { isReadable: readable });
    expect(r.class).toBe("standard");
    expect(r.signals.join(" ")).not.toContain("zarquon");
  });
});

describe("THE-691: the count is EXACT, not a sample of the first page", () => {
  // These are the cases the first version of this fix got wrong. It read ONE page of 200 matches
  // and filtered it, so the answer depended on where readable rows happened to fall among hidden
  // ones — which made it both incorrect and still a function of content the caller cannot see.
  const hidden = (n: number, term: string) =>
    Array.from({ length: n }, (_, i) => ({
      id: `h${i}`,
      path: `09-private/h${i}.md`,
      content: term,
    }));

  it("finds a readable rare term sitting BEYOND a page of hidden matches", () => {
    // 250 hidden rows then one readable: a single 200-row page never reaches it and reports df=0,
    // so the term silently stops routing lexical.
    const db = dbWith([
      ...hidden(250, "zarquon"),
      { id: "vis", path: "00-visible.md", content: "zarquon" },
    ]);
    const r = routeQuery(db, VAULT, "zarquon", { isReadable: readable });
    expect(r.signals.join(" ")).toContain("df=1");
    expect(r.class).toBe("lexical");
  });

  it("does not undercount INTO the rare window when readable matches are spread out", () => {
    // Five readable matches, interleaved past a page boundary. Sampling one page could see just
    // one of them and report df=1 -> routes lexical, when the true readable df is 5 -> standard.
    const rows = [
      { id: "v0", path: "00-a.md", content: "zarquon" },
      ...hidden(220, "zarquon"),
      { id: "v1", path: "00-b.md", content: "zarquon" },
      { id: "v2", path: "00-c.md", content: "zarquon" },
      { id: "v3", path: "00-d.md", content: "zarquon" },
      { id: "v4", path: "00-e.md", content: "zarquon" },
    ];
    const r = routeQuery(dbWith(rows), VAULT, "zarquon", { isReadable: readable });
    expect(r.class).toBe("standard");
    expect(r.signals.join(" ")).not.toContain("zarquon");
  });

  it("hidden rows cannot change routing for an otherwise identical readable corpus", () => {
    // The non-interference property stated directly: same readable content, wildly different
    // amounts of denied content, identical decision and identical signals.
    const visible = [{ id: "vis", path: "00-visible.md", content: "zarquon" }];
    const bare = routeQuery(dbWith(visible), VAULT, "zarquon", { isReadable: readable });
    const buried = routeQuery(dbWith([...hidden(400, "zarquon"), ...visible]), VAULT, "zarquon", {
      isReadable: readable,
    });
    expect(buried.class).toBe(bare.class);
    expect(buried.signals).toEqual(bare.signals);
  });
});

describe("THE-691: the paging loop terminates at every page boundary", () => {
  // The cursor advances on `rowid > last`, so a page that lands exactly on the boundary is the
  // case worth pinning: the loop issues one more query, gets zero rows, and stops. An off-by-one
  // here is either an infinite loop on a hot path or a silently skipped row at the seam.
  const hidden = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `h${i}`,
      path: `09-private/h${i}.md`,
      content: "zarquon",
    }));

  it("a match set of EXACTLY one page, none readable", () => {
    const r = routeQuery(dbWith(hidden(200)), VAULT, "zarquon", { isReadable: readable });
    expect(r.class).toBe("standard");
  });

  it("exactly one full page hidden, with the only readable match on page two", () => {
    const rows = [...hidden(200), { id: "v", path: "00-v.md", content: "zarquon" }];
    const r = routeQuery(dbWith(rows), VAULT, "zarquon", { isReadable: readable });
    expect(r.signals.join(" ")).toContain("df=1");
  });

  it("two full pages, none readable", () => {
    const r = routeQuery(dbWith(hidden(400)), VAULT, "zarquon", { isReadable: readable });
    expect(r.class).toBe("standard");
  });
});
