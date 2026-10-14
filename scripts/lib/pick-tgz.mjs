// Print the one `<prefix><version>.tgz` in <dir>. The workflow calls this instead of a bash glob:
// on Windows runners RUNNER_TEMP is a backslash path, and bash pathname expansion treats `\` as
// an escape, so a glob over it matches nothing.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function pickTgz(dir, prefix) {
  const matches = readdirSync(dir).filter(
    (f) => f.startsWith(prefix) && /^\d.*\.tgz$/.test(f.slice(prefix.length)),
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${prefix}<version>.tgz in ${dir}, found ${matches.length}: ${matches.join(", ")}`,
    );
  }
  return join(dir, matches[0]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, prefix] = process.argv.slice(2);
  try {
    console.log(pickTgz(dir, prefix));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
