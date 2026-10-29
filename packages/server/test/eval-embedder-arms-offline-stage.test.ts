// The offline index stage (eval/embedder-arms-offline.ts indexOfflineArm) run end to end on a sqlite file: the export,
// a GPU run's vectors loaded under the provider id, and a stale ids file refused before any export file changes. The
// stage is called directly with its output collected, so nothing shells out to bun or Modal and nothing hits the network.
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { armByName } from "../eval/embedder-arms-lib";
import {
  armDir,
  indexOfflineArm,
  indexRerunArgs,
  nextEmbedCommand,
  type OfflineIndexInput,
} from "../eval/embedder-arms-offline";
import { gpuVecsModelId } from "../eval/gpu-embed-lib";
import { provisionCacheDb } from "../src/db/provision";
import { compileEgressFilter } from "../src/plane/egress-filter";

const DIM = 768;
const NOMIC = { provider: "local", model: "nomic-embed-text-v1.5", dimensions: DIM };
const CACHE_DIR = "/nonexistent/otc-cache"; // never read: the local provider loads its model lazily
const arm = armByName("nomic-v1.5-768");
const model = gpuVecsModelId(NOMIC, CACHE_DIR);
const OLD = new Date(1_000_000); // an mtime the stage must either change (a rewrite) or leave alone

let tmp: string;
let dbPath: string;
let exp: string;
let expDir: string;
let out: string[];
let db: any; // the stage takes the repo's Database type; the sqlite handle here is node:sqlite's, as in eval-gpu-embed

const exportFile = (name: string): string => join(expDir, name);

function seed(id: string, vaultId: string, path: string): void {
  db.prepare(
    `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash,
                         token_count, created_at, updated_at)
     VALUES (?, ?, ?, '0', '[]', 'body', ?, 1, 0, 0)`,
  ).run(id, vaultId, path, `h-${id}`);
}

/** Finite vectors, one row per id: the values only have to be well-formed, the loader checks their shape. */
function floats(rows: number): Buffer {
  const out = new Float32Array(rows * DIM);
  for (let i = 0; i < out.length; i++) out[i] = (i % 97) / 97 + 0.01;
  return Buffer.from(out.buffer);
}

/** The chunk ids stored under the provider id, read through a fresh connection (the stage closes its own). */
function rowsUnder(provider: string): string[] {
  const conn = new DatabaseSync(dbPath);
  try {
    const rows = conn
      .prepare("SELECT chunk_id FROM chunk_embeddings WHERE model = ? ORDER BY chunk_id")
      .all(provider) as Array<{ chunk_id: string }>;
    return rows.map((r) => r.chunk_id);
  } finally {
    conn.close();
  }
}

function run(input: OfflineIndexInput): 0 | 3 {
  return indexOfflineArm(db, {
    arm,
    corpus: "public",
    exp,
    vaultId: "v1",
    filter: compileEgressFilter([]),
    model,
    input,
    out: (text) => out.push(text),
  });
}

/** Pushes the export files' mtimes back so that a write (or its absence) shows in the timestamps. */
function ageExport(): void {
  for (const f of ["ids.json", "texts.jsonl"]) utimesSync(exportFile(f), OLD, OLD);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "offline-stage-"));
  dbPath = join(tmp, "cache.db");
  exp = join(tmp, "exp");
  expDir = join(armDir(exp, arm), "export");
  out = [];
  db = new DatabaseSync(dbPath);
  provisionCacheDb(db);
  seed("c-a", "v1", "a.md");
  seed("c-b", "v1", "b.md");
  seed("c-x", "v2", "x.md"); // another vault: the stage exports the vault it is given, and only that one
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // the stage closes the handle after a successful load
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("offline index stage, end to end", () => {
  it("with no vectors: writes the export, returns 3, and prints the GPU command to run", () => {
    expect(run({})).toBe(3);
    expect(JSON.parse(readFileSync(exportFile("ids.json"), "utf8"))).toEqual(["c-a", "c-b"]);
    expect(readFileSync(exportFile("texts.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
    const printed = out.join("");
    expect(printed).toContain(`run off-box: ${nextEmbedCommand(arm, expDir)}`);
    expect(printed).toContain(`plus ${indexRerunArgs(arm, expDir)}`);
    expect(rowsUnder(model)).toEqual([]);
  });

  it("with the GPU run's vectors and ids: loads the rows under the provider id, then rewrites the export", () => {
    run({});
    const ids = JSON.parse(readFileSync(exportFile("ids.json"), "utf8")) as string[];
    const vecsPath = join(tmp, "vecs-768.f32");
    const idsPath = join(tmp, "vecs-768-ids.json");
    writeFileSync(vecsPath, floats(ids.length));
    writeFileSync(idsPath, JSON.stringify(ids));
    ageExport();

    expect(run({ vecsPath, idsPath })).toBe(0);
    expect(rowsUnder(model)).toEqual(["c-a", "c-b"]);
    expect(out.at(-1)).toBe(`index ${arm.name}: 2/2 chunks embedded under ${model}\n`);
    expect(statSync(exportFile("ids.json")).mtimeMs).toBeGreaterThan(OLD.getTime());
  });

  it("a stale ids file (reordered) is refused before any export file changes, and loads no rows", () => {
    run({});
    const ids = JSON.parse(readFileSync(exportFile("ids.json"), "utf8")) as string[];
    const vecsPath = join(tmp, "vecs-768.f32");
    const idsPath = join(tmp, "vecs-768-ids.json");
    writeFileSync(vecsPath, floats(ids.length));
    writeFileSync(idsPath, JSON.stringify([...ids].reverse()));
    ageExport();
    const before = {
      ids: readFileSync(exportFile("ids.json"), "utf8"),
      texts: readFileSync(exportFile("texts.jsonl"), "utf8"),
    };

    expect(() => run({ vecsPath, idsPath })).toThrow(/differ from the fresh export at position 0/);
    expect(readFileSync(exportFile("ids.json"), "utf8")).toBe(before.ids);
    expect(readFileSync(exportFile("texts.jsonl"), "utf8")).toBe(before.texts);
    expect(statSync(exportFile("ids.json")).mtimeMs).toBe(OLD.getTime());
    expect(statSync(exportFile("texts.jsonl")).mtimeMs).toBe(OLD.getTime());
    expect(rowsUnder(model)).toEqual([]);
  });
});
