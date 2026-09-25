#!/usr/bin/env node
/**
 * THE-1122 review — README.md size cap.
 *
 * README.md is embedded verbatim on npm's package page, GitHub's repo landing page, and (via
 * server.json) the MCP Registry listing — none of which truncate gracefully, and all of which are
 * a worse reading experience past a certain length. This repo's own review process caught README.md
 * growing 359 bytes past a 12,288-byte (12 KiB) cap during THE-1122 with nothing to flag it
 * mechanically; a human re-reading the whole file on every PR to notice growth does not scale.
 *
 * 12,288 is not derived from anything external (no known host actually enforces this number) — it
 * is this repo's own chosen ceiling, room enough for THE-1122's honest npm/Docker caveat while
 * still refusing to let the file grow unboundedly. Bump CAP_BYTES deliberately, with a reason, if a
 * future change genuinely needs more room — the point of this gate is a considered increase, not a
 * hard wall nothing can ever cross.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const README_PATH = join(ROOT, "README.md");
export const CAP_BYTES = 12288;

/** Pure — takes the byte length rather than reading the file itself, so it is directly testable
 *  with a fabricated size (no fixture file needed). */
export function checkReadmeSize(byteLength, capBytes = CAP_BYTES) {
  if (byteLength <= capBytes) {
    return { ok: true, byteLength, capBytes };
  }
  return { ok: false, byteLength, capBytes, overBy: byteLength - capBytes };
}

function main() {
  const byteLength = Buffer.byteLength(readFileSync(README_PATH, "utf8"), "utf8");
  const result = checkReadmeSize(byteLength);
  if (result.ok) {
    console.log(
      `check-readme-size: OK — README.md is ${result.byteLength} bytes (cap ${result.capBytes}).`,
    );
    process.exit(0);
  }
  console.error(
    `check-readme-size: README.md is ${result.byteLength} bytes, ${result.overBy} over the ` +
      `${result.capBytes}-byte cap (see this script's own header for where that number comes ` +
      "from). Trim the diff rather than the cap by default — this is usually easiest by moving " +
      "detail into docs/ and leaving a link, the same move THE-1122's own README changes made. " +
      "If the cap itself genuinely needs to grow, bump CAP_BYTES in scripts/check-readme-size.mjs " +
      "with a comment explaining why.",
  );
  process.exit(1);
}

// Importing this module (as its test file does) must have no side effects — no filesystem reads,
// no process.exit. Only run the gate when this file is the process entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
