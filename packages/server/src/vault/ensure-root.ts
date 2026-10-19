// Creates the env-configured vault root when it is missing, so a fresh volume mounted over `/data`
// (which hides the image's own `/data/vault`) does not stop the first boot.
//
// Only a path that came from OBSIDIAN_TC_VAULT_PATH qualifies: the overlay makes that variable win
// over the file, so "the one vault's path equals the variable" is exactly "the path came from the
// variable". A path written only in the config file still fails loudly when missing. The directory
// is made with a non-recursive mkdir (its parent must already exist, and a symlink at the final
// component fails EEXIST rather than being followed); anything already at the path is left alone.
import { lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type EnsureVaultRootOutcome = "created" | "skipped";

/** `undefined` for ENOENT/ENOTDIR (nothing usable there); any other failure is the caller's. */
function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

export function ensureEnvVaultRoot(
  vaults: ReadonlyArray<{ path?: string }>,
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = (line) => void process.stderr.write(line),
): EnsureVaultRootOutcome {
  const envPath = env.OBSIDIAN_TC_VAULT_PATH;
  if (!envPath) return "skipped";
  const onlyPath = vaults.length === 1 ? vaults[0]?.path : undefined;
  if (onlyPath === undefined || resolve(onlyPath) !== resolve(envPath)) return "skipped";

  const target = resolve(envPath);
  const parent = dirname(target);
  if (lstatOrUndefined(target) !== undefined) return "skipped";
  const parentStat = lstatOrUndefined(parent);
  if (parentStat === undefined) return "skipped";
  if (parentStat.isSymbolicLink()) {
    throw new Error(
      `refusing to create the vault root ${target}: its parent ${parent} is a symlink`,
    );
  }
  if (!parentStat.isDirectory()) return "skipped";

  try {
    mkdirSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return "skipped";
    throw new Error(`cannot create the vault root ${target}: ${code ?? String(error)}`, {
      cause: error,
    });
  }
  log(`obsidian-tc: created the missing vault root ${target} (OBSIDIAN_TC_VAULT_PATH)\n`);
  return "created";
}
