// Child process for server-secret-followups.test.ts: plays a repairer that holds the repair lock and
// keeps the key file absent for the instant between moving it aside and linking it back, over and
// over. A reader that opens the path in that instant gets ENOENT; it must wait for the lock holder
// and adopt the key it puts back, never publish a key of its own into the gap.
//
// The loop ends only when the optional stop file (argv[3]) exists, checked between iterations with the
// lock released, so the process exits with the key in place. The test awaits that exit before it reads
// the key itself: at any other instant the file may be aside and the read gets ENOENT.
import {
  existsSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { ownerRecord } from "../src/auth/server-secret";

const path = process.argv[2] as string;
const stopFile = process.argv[3];
const aside = `${path}.mover`;
const lock = `${path}.repair-lock`;
process.stdout.write("ready\n");
while (!(stopFile && existsSync(stopFile))) {
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    continue; // a reader holds the lock: wait for it
  }
  try {
    writeFileSync(`${lock}/owner`, JSON.stringify(ownerRecord("mover")), { mode: 0o600 });
    renameSync(path, aside);
    linkSync(aside, path);
    unlinkSync(aside);
  } finally {
    try {
      unlinkSync(`${lock}/owner`);
      rmdirSync(lock);
    } catch {
      // nothing to release
    }
  }
}
