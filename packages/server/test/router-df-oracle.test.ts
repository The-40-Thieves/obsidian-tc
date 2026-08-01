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

function dbWith(rows: Array<{ id: string; path: string; content: string }>): Database | null {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  const ins = db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, '0', '[]', ?, ?, 1, 0, 0)",
  );
  for (const r of rows) ins.run(r.id, VAULT, r.path, r.content, `h-${r.id}`);
  return ensureChunkFts(db) ? db : null; // FTS5 not compiled into this runtime
}

describe("THE-691: routeQuery must not leak unreadable term existence", () => {
  it("a term present ONLY in an unreadable note is indistinguishable from an absent term", () => {
    const db = dbWith([{ id: "p", path: "09-private/secret.md", content: "zarquon classified" }]);
    if (!db) return;

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
    if (!db) return;

    const leaked = routeQuery(db, VAULT, "zarquon");
    expect(leaked.signals.join(" ")).toContain("zarquon");
    expect(leaked.signals.join(" ")).toContain("df=1");
  });

  it("a READABLE rare term still routes lexical — the fix must not disable the feature", () => {
    const db = dbWith([{ id: "v", path: "00-public.md", content: "zarquon visible" }]);
    if (!db) return;

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
    if (!db) return;

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
    if (!db) return;

    const r = routeQuery(db, VAULT, "zarquon", { isReadable: readable });
    expect(r.class).toBe("standard");
    expect(r.signals.join(" ")).not.toContain("zarquon");
  });
});
