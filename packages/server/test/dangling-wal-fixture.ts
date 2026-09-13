// A genuinely DANGLING WAL — a writer killed before it could checkpoint (THE-1039 C2).
//
// Extracted from doctor-db-space.test.ts in fix round 4 (H4) so `compact --dry-run` and `--into`
// assert the bytes-unchanged property against the SAME fixture doctor's probe does, rather than a
// second copy of it: "a readonly inspection connection cannot trigger SQLite's own
// checkpoint-on-close" is ONE behaviour shared by every inspection call site, and two hand-built
// fixtures could drift apart silently.
//
// A child PROCESS, not an in-process connection: the WAL must be left un-checkpointed by a writer
// that no longer exists, which SIGKILL is the only way to arrange. An in-process version could only
// approximate it ("not yet auto-checkpointed by this same process's next write").
import { spawn } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Build `<dir>/cache.db` in WAL mode and leave its `-wal` dangling. Returns the database path.
 *
 * Self-checks the fixture before returning — a test asserting "these bytes did not change" proves
 * nothing if the `-wal` it was supposed to be dangling is absent or empty.
 */
export async function createDanglingWalDb(dir: string): Promise<string> {
  const dbPath = join(dir, "cache.db");
  const scriptPath = join(dir, "dangling-wal-writer.cjs");
  writeFileSync(
    scriptPath,
    [
      'const { DatabaseSync } = require("node:sqlite");',
      "const db = new DatabaseSync(process.argv[2]);",
      'db.exec("PRAGMA journal_mode = WAL");',
      'db.exec("PRAGMA wal_autocheckpoint = 0");', // never auto-checkpoint on its own
      'db.exec("CREATE TABLE t(x)");',
      'db.exec("INSERT INTO t VALUES (1),(2),(3)");',
      'process.stdout.write("ready\\n");',
      "setInterval(() => {}, 1000);", // stay alive (with the WAL un-checkpointed) until killed
    ].join("\n"),
  );

  const child = spawn(process.execPath, [scriptPath, dbPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("writer did not become ready")), 10_000);
    child.stdout.on("data", (d: Buffer) => {
      if (d.toString().includes("ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));

  if (!existsSync(`${dbPath}-wal`) || statSync(`${dbPath}-wal`).size === 0) {
    throw new Error(`fixture left no dangling -wal beside ${dbPath}`);
  }
  return dbPath;
}
