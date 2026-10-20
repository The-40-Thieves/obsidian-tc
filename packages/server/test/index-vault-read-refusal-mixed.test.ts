// One refused note does not hold the rest of the pass hostage. A separate file: the readNote mock
// below must not reach any other test's module graph.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { readableByFolder } from "../src/vault/acl-read-filter";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

vi.mock("../src/vault/notes-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault/notes-io")>();
  return {
    ...actual,
    readNote: (abs: string) => {
      if (abs.endsWith("b.md"))
        throw err.aclDenied("safe open refused the path: test", { path: abs });
      return actual.readNote(abs);
    },
  };
});

const provider = fakeEmbeddingProvider({ dimensions: 32 });
const representation = buildRepresentationManifest(provider, {});
const OPEN_ACL = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe("one refused note does not hold the rest of the pass hostage", () => {
  it("the pass resolves, indexes the other notes, and the refused note has no chunks", async () => {
    const root = makeTempDir("obtc-read-refusal-mixed-");
    cleanups.push(() => rmTemp(root));
    for (const rel of ["n/a.md", "n/b.md", "n/c.md"]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), `# ${rel}\n\nzebra ${rel}\n`);
    }
    const db = openMemoryDb();
    provisionCacheDb(db);
    const stats = await indexVault({
      db,
      provider,
      representation,
      vaultId: "v",
      root,
      isReadable: (rel) => readableByFolder(OPEN_ACL, rel),
    });
    expect(stats.notes_indexed).toBe(2);
    expect(stats.notes_read_refused).toBe(1);
    expect(stats.read_refusals.map((r) => r.path)).toEqual(["n/b.md"]);
    const rows = db
      .prepare("SELECT DISTINCT path FROM chunks WHERE path LIKE 'n/%'")
      .all() as Array<{
      path: string;
    }>;
    expect(rows.map((r) => r.path).sort()).toEqual(["n/a.md", "n/c.md"]);
  });
});
