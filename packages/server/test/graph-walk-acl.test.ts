// THE-695 item 1 — an unreadable note is a usable BRIDGE.
//
// `expandGraphLiteral` has no ACL awareness: its recursive CTE traverses vault_edges filtered only
// on vault_id and edge_type. `graph_expansion.ts` applies `isReadable` to the HYDRATED chunk rows,
// after the walk has already finished. So with hopLimit=2 (the default):
//
//   readable A  ->  unreadable S  ->  readable B
//
// B is reached at hop 2 ONLY because S exists. Remove S and B is unreachable. B is readable, so B
// appears in the results — meaning the presence of an unreadable note changes the READABLE result
// set. Same root shape as THE-287 (dense), THE-632 (lexical + sparse) and THE-691 (router df): an
// aggregate computed over the whole corpus and surfaced to a caller who sees part of it. The graph
// arm is the one that was never swept.
//
// Pruning bridges is a RECALL change — measured on a live snapshot with a restricted ACL, a 2-hop
// walk went from 583 nodes to 57 — so it ships behind a flag and the eval decides it.
import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/types";
import { expandGraphLiteral } from "../src/search/graph_expand";
import { openMemoryDb } from "./helpers";

function bridged(): Database {
  const db = openMemoryDb();
  db.exec(
    "CREATE TABLE vault_edges (vault_id TEXT NOT NULL, source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL, edge_kind TEXT, provenance TEXT)",
  );
  db.exec(
    "CREATE TABLE acl_path_sets (set_id INTEGER PRIMARY KEY, acl_fingerprint TEXT NOT NULL, vault_id TEXT NOT NULL, generation INTEGER NOT NULL, built_at INTEGER NOT NULL, path_count INTEGER NOT NULL, UNIQUE (acl_fingerprint, vault_id))",
  );
  db.exec(
    "CREATE TABLE acl_path_members (set_id INTEGER NOT NULL REFERENCES acl_path_sets(set_id) ON DELETE CASCADE, path TEXT NOT NULL, PRIMARY KEY (set_id, path)) WITHOUT ROWID",
  );
  const e = db.prepare(
    "INSERT INTO vault_edges VALUES ('main', ?, ?, 'links_to', 'literal', 'body')",
  );
  e.run("public/a.md", "secret/s.md");
  e.run("secret/s.md", "public/b.md");
  db.prepare("INSERT INTO acl_path_sets VALUES (1,'fp','main',1,1,2)").run();
  const m = db.prepare("INSERT INTO acl_path_members VALUES (1, ?)");
  m.run("public/a.md");
  m.run("public/b.md"); // secret/s.md deliberately absent
  return db;
}

const walk = (db: Database, opts: Record<string, unknown>): string[] =>
  expandGraphLiteral(db, ["public/a.md"], { vaultId: "main", hopLimit: 2, ...opts }).map(
    (n) => n.path,
  );

describe("THE-695 graph walk bridges", () => {
  it("reaches B through an unreadable bridge today", () => {
    // Documents the defect, and is what keeps the next test non-vacuous.
    expect(walk(bridged(), {})).toContain("public/b.md");
  });

  it("cannot traverse the unreadable bridge when the set is joined", () => {
    const paths = walk(bridged(), { aclSetId: 1 });
    // B is READABLE, but it was only reachable via S. Its presence therefore depended on an
    // unreadable note, which is the non-interference violation — not a content leak.
    expect(paths).not.toContain("public/b.md");
    expect(paths).not.toContain("secret/s.md");
  });

  it("still reaches a readable neighbour that needs no bridge", () => {
    const db = bridged();
    db.prepare(
      "INSERT INTO vault_edges VALUES ('main','public/a.md','public/c.md','links_to','literal','body')",
    ).run();
    db.prepare("INSERT INTO acl_path_members VALUES (1,'public/c.md')").run();
    // Pruning bridges must not prune direct links — otherwise the flag is just "turn off expansion".
    expect(walk(db, { aclSetId: 1 })).toContain("public/c.md");
  });

  it("still reaches a readable node via a readable 2-hop path", () => {
    const db = bridged();
    const e = db.prepare(
      "INSERT INTO vault_edges VALUES ('main', ?, ?, 'links_to', 'literal', 'body')",
    );
    e.run("public/a.md", "public/mid.md");
    e.run("public/mid.md", "public/far.md");
    const m = db.prepare("INSERT INTO acl_path_members VALUES (1, ?)");
    m.run("public/mid.md");
    m.run("public/far.md");
    // Two hops entirely through readable nodes must survive, or the filter is cutting depth rather
    // than cutting bridges.
    expect(walk(db, { aclSetId: 1 })).toContain("public/far.md");
  });

  it("is a no-op when no set id is supplied", () => {
    // The dark-ship contract: absent the flag, behaviour is byte-identical to today.
    expect(walk(bridged(), { aclSetId: undefined })).toContain("public/b.md");
  });
});
