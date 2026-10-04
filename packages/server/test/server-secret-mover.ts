// Child process for server-secret-followups.test.ts: keeps the key file absent for the instant
// between moving it aside and linking it back, over and over, which is what a repairer does. A
// reader that opens the path in that instant gets ENOENT and must not treat it as an error.
import { linkSync, renameSync, unlinkSync } from "node:fs";

const path = process.argv[2] as string;
const aside = `${path}.mover`;
process.stdout.write("ready\n");
for (;;) {
  try {
    renameSync(path, aside);
    linkSync(aside, path);
    unlinkSync(aside);
  } catch {
    // a reader published its own key into the gap: the next pass moves that one instead
  }
}
