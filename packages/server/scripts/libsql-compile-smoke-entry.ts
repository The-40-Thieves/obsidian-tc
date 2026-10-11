// Entry compiled by libsql-compile-smoke.sh: opens a database through the real libsql adapter from
// inside a `bun build --compile` binary and asserts what the experimental libsql path promises.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLibsql } from "../src/db/libsql";
import { loadVec } from "../src/search/vec";

const dir = mkdtempSync(join(tmpdir(), "otc-libsql-smoke-"));
try {
  const db = await openLibsql(join(dir, "smoke.db"));
  const version = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
  if (!version.startsWith("3.45")) throw new Error(`sqlite_version ${version}, expected 3.45.x`);

  db.exec("CREATE VIRTUAL TABLE docs USING fts5(body)");
  db.prepare("INSERT INTO docs (body) VALUES (?)").run("the quick brown fox");
  db.prepare("INSERT INTO docs (body) VALUES (?)").run("a lazy dog");
  const hits = db.prepare("SELECT body FROM docs WHERE docs MATCH ?").all("fox") as {
    body: string;
  }[];
  if (hits.length !== 1 || hits[0]?.body !== "the quick brown fox") {
    throw new Error(`fts5 MATCH returned ${JSON.stringify(hits)}`);
  }

  if (!loadVec(db)) throw new Error("loadVec failed: vec0 is not embedded or not loadable");
  const vec = (db.prepare("SELECT vec_version() AS v").get() as { v: string }).v;
  db.close();
  console.log(`libsql-compile-smoke: ok sqlite=${version} fts5=1 vec_version=${vec}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
