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

// THE-852 — the rigorous two-world differential (research brief section 4.2). Membership-only
// equality (what the tests above check) can pass even while a hidden node still shifts a readable
// node's HOP or PREDECESSOR — this asserts full-field equality between:
//   World A: the bridge present, but ACL-filtered (aclSetId joined).
//   World B: the bridge PHYSICALLY REMOVED from vault_edges (the "as if it never existed" ground
//            truth) — same walk, same seeds, no ACL filter needed because there is nothing to hide.
// expandGraphLiteral has no scoring of its own (that only happens in graph_expansion.ts), so this
// is a clean structural proof of the CTE join with no BM25/corpus-stat confound.
describe("THE-852 two-world differential — full-field non-interference", () => {
  const fullWalk = (db: Database, seeds: string[], opts: Record<string, unknown> = {}) =>
    expandGraphLiteral(db, seeds, { vaultId: "main", hopLimit: 2, ...opts })
      // Sort for a stable comparison — the walk's own GROUP BY order is not a contract this test
      // needs to pin, only that the SET of full node records is identical between the two worlds.
      .sort((a, b) => a.path.localeCompare(b.path));

  it("World A (filtered, bridge present) === World B (bridge physically removed) — every field", () => {
    const worldA = bridged(); // a -> s -> b, s NOT in acl_path_members
    const nodesA = fullWalk(worldA, ["public/a.md"], { aclSetId: 1 });

    const worldB = openMemoryDb();
    worldB.exec(
      "CREATE TABLE vault_edges (vault_id TEXT NOT NULL, source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL, edge_kind TEXT, provenance TEXT)",
    );
    // No a->s or s->b edges at all: s does not exist in this world's graph. No ACL join needed —
    // there is nothing unreadable left to filter.
    const nodesB = fullWalk(worldB, ["public/a.md"]);

    expect(nodesA).toStrictEqual(nodesB);
    expect(nodesA).toStrictEqual([]); // ground truth: with s gone, a reaches nothing
  });

  it("holds with a readable direct link ALSO present — the filter prunes only the bridge-only path", () => {
    const worldA = bridged();
    worldA
      .prepare(
        "INSERT INTO vault_edges VALUES ('main','public/a.md','public/c.md','links_to','literal','body')",
      )
      .run();
    worldA.prepare("INSERT INTO acl_path_members VALUES (1,'public/c.md')").run();
    const nodesA = fullWalk(worldA, ["public/a.md"], { aclSetId: 1 });

    const worldB = openMemoryDb();
    worldB.exec(
      "CREATE TABLE vault_edges (vault_id TEXT NOT NULL, source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL, edge_kind TEXT, provenance TEXT)",
    );
    worldB
      .prepare(
        "INSERT INTO vault_edges VALUES ('main','public/a.md','public/c.md','links_to','literal','body')",
      )
      .run();
    const nodesB = fullWalk(worldB, ["public/a.md"]);

    expect(nodesA).toStrictEqual(nodesB);
    expect(nodesA.map((n) => n.path)).toStrictEqual(["public/c.md"]);
    // hop/predecessor/via_edge_* must match too, not just membership.
    expect(nodesA[0]).toMatchObject({
      hop: 1,
      predecessor_path: "public/a.md",
      root_seed: "public/a.md",
      via_edge_type: "links_to",
      edge_kind: "literal",
    });
  });

  // Property/fuzz variant (brief section 4.2 item 3): a handful of random bridge topologies, each
  // checked against its own physically-removed ground truth. Catches diamond/multi-bridge shapes a
  // single hand-picked fixture misses.
  it("holds over randomly generated bridge topologies", () => {
    let seed = 42;
    const rand = () => {
      // xorshift32 — deterministic across CI runs, no external dependency.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) % 1000) / 1000;
    };

    for (let trial = 0; trial < 25; trial++) {
      const nUnreadable = 1 + Math.floor(rand() * 3);
      const nReadable = 2 + Math.floor(rand() * 4);
      const readablePaths = Array.from({ length: nReadable }, (_, i) => `r/${trial}-${i}.md`);
      const unreadablePaths = Array.from({ length: nUnreadable }, (_, i) => `u/${trial}-${i}.md`);
      const allPaths = [...readablePaths, ...unreadablePaths];

      // Random edges among all paths (readable and unreadable), undirected walk so direction of
      // insertion does not matter to expandGraphLiteral's own UNION ALL.
      const edges: Array<[string, string]> = [];
      for (let i = 0; i < allPaths.length * 2; i++) {
        const from = allPaths[Math.floor(rand() * allPaths.length)] as string;
        const to = allPaths[Math.floor(rand() * allPaths.length)] as string;
        if (from !== to) edges.push([from, to]);
      }

      const buildWorld = (includeUnreadable: boolean): Database => {
        const db = openMemoryDb();
        db.exec(
          "CREATE TABLE vault_edges (vault_id TEXT NOT NULL, source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL, edge_kind TEXT, provenance TEXT)",
        );
        const ins = db.prepare(
          "INSERT INTO vault_edges VALUES ('main', ?, ?, 'links_to', 'literal', 'body')",
        );
        for (const [from, to] of edges) {
          if (
            !includeUnreadable &&
            (unreadablePaths.includes(from) || unreadablePaths.includes(to))
          )
            continue;
          ins.run(from, to);
        }
        return db;
      };

      // World A: every edge present, ACL-joined against the readable-only set.
      const worldA = buildWorld(true);
      setupAclFixture(worldA, readablePaths);
      const nodesA = fullWalk(worldA, [readablePaths[0] as string], { aclSetId: 1 });

      // World B: unreadable nodes and every edge touching them physically absent.
      const worldB = buildWorld(false);
      const nodesB = fullWalk(worldB, [readablePaths[0] as string]);

      expect(nodesA).toStrictEqual(nodesB);
      // Non-vacuous per-trial: no unreadable path ever appears, in either its own right or as a
      // predecessor.
      for (const n of nodesA) {
        expect(unreadablePaths).not.toContain(n.path);
        expect(unreadablePaths).not.toContain(n.predecessor_path);
      }
    }
  });
});

/** Provisions acl_path_sets/acl_path_members (set_id=1) with exactly `readablePaths` as members —
 *  the fuzz test's per-trial ACL fixture, factored out for readability. */
function setupAclFixture(db: Database, readablePaths: string[]): void {
  db.exec(
    "CREATE TABLE acl_path_sets (set_id INTEGER PRIMARY KEY, acl_fingerprint TEXT NOT NULL, vault_id TEXT NOT NULL, generation INTEGER NOT NULL, built_at INTEGER NOT NULL, path_count INTEGER NOT NULL, UNIQUE (acl_fingerprint, vault_id))",
  );
  db.exec(
    "CREATE TABLE acl_path_members (set_id INTEGER NOT NULL REFERENCES acl_path_sets(set_id) ON DELETE CASCADE, path TEXT NOT NULL, PRIMARY KEY (set_id, path)) WITHOUT ROWID",
  );
  db.prepare("INSERT INTO acl_path_sets VALUES (1,'fp','main',1,1,?)").run(readablePaths.length);
  const m = db.prepare("INSERT INTO acl_path_members VALUES (1, ?)");
  for (const p of readablePaths) m.run(p);
}
