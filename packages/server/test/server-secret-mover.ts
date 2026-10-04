// Child process for server-secret-followups.test.ts: plays a repairer that holds the repair lock and
// keeps the key file absent for the instant between moving it aside and linking it back, over and
// over. A reader that opens the path in that instant gets ENOENT; it must wait for the lock holder
// and adopt the key it puts back, never publish a key of its own into the gap.
import { linkSync, mkdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";

const path = process.argv[2] as string;
const aside = `${path}.mover`;
const lock = `${path}.repair-lock`;
process.stdout.write("ready\n");
for (;;) {
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    continue; // a reader holds the lock: wait for it
  }
  try {
    writeFileSync(`${lock}/owner`, "mover", { mode: 0o600 });
    renameSync(path, aside);
    linkSync(aside, path);
    unlinkSync(aside);
  } finally {
    try {
      unlinkSync(`${lock}/owner`);
      rmdirSync(lock);
    } catch {
      // a reader broke the lock; nothing to release
    }
  }
}
