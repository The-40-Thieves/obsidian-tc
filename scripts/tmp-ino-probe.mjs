import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const d = mkdtempSync(join(tmpdir(), "ino-"));
console.log("tmpdir", tmpdir(), "MAX_SAFE", Number.MAX_SAFE_INTEGER);
for (let i = 0; i < 8; i++) {
  const p = join(d, `f${i}`);
  writeFileSync(p, "x");
  const n = statSync(p);
  const b = statSync(p, { bigint: true });
  console.log(
    i,
    "ino",
    n.ino,
    "bigint",
    b.ino,
    "dev",
    n.dev,
    b.dev,
    "unsafe",
    !Number.isSafeInteger(n.ino),
    "ino+1==ino",
    n.ino + 1 === n.ino,
    "roundtrip",
    BigInt(n.ino) === b.ino,
  );
}
