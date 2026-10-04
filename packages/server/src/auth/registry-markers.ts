// Where the auth registry lives on disk and how a LOST one is recognised: the keys directory, the
// per-table durable markers and the operator-facing loss message. Split out of registry.ts (the
// registry itself keeps its file-length budget); registry.ts re-exports every name here, so callers
// keep importing them from "./registry".
import { join } from "node:path";
import { existsNoFollow, keyFileNames, keysDirProblem } from "./key-files";

export function authKeysDir(cacheDir: string): string {
  return join(cacheDir, "auth-keys");
}

/** The registry's own database file: NOT regenerable, back it up. */
export function authDbPath(cacheDir: string): string {
  return join(cacheDir, "auth.db");
}

/** Which part of the registry a durable marker protects: `mint`-purpose keys, `as`-purpose keys, or
 *  the issued/revoked tokens. */
export type RegistryTable = "keys" | "as-keys" | "tokens";

/** File-name prefix of an `as`-purpose key file (`as-<kid>.key`): how a key file is attributed to a
 *  purpose without opening it or the database. */
export const AS_KEY_FILE_PREFIX = "as-";

const MARKER_FILES: Record<RegistryTable, string> = {
  keys: ".keys-initialized",
  "as-keys": ".as-keys-initialized",
  tokens: ".tokens-initialized",
};

/** Marker written with the first `mint` key rotation (`keys`), the first `as` key (`as-keys`) or the
 *  first recorded token or revocation (`tokens`). Lives beside the key files, outside the database,
 *  so that losing a table is detectable. Per purpose, so a registry holding only `as` keys still
 *  reads as "no mint key was ever rotated in": the configured secret stays the only mint key. */
export function registryMarkerPath(keysDir: string, table: RegistryTable): string {
  return join(keysDir, MARKER_FILES[table]);
}

export interface RegistryInitState {
  /** A `mint` key was ever rotated in: the keys marker, or any `*.key` file that is not an `as` key's. */
  keys: boolean;
  /** An `as` key was ever created: the as-keys marker, or any `as-*.key` file. */
  asKeys: boolean;
  /** A token or revocation was ever written: the tokens marker. */
  tokens: boolean;
  /** Set when `keysDir` is a symlink or not a directory. Both tables then count as initialised: an
   *  unusable directory is refused, never read as "nothing was ever here". */
  dirProblem?: string;
}

/** What the durable markers say about this deployment. `lstat` first: a symlink (even to an empty
 *  directory) is a refusal, and is never followed to look for markers or key files. */
export function registryInitState(keysDir: string): RegistryInitState {
  const dirProblem = keysDirProblem(keysDir);
  if (dirProblem !== undefined) return { keys: true, asKeys: true, tokens: true, dirProblem };
  const files = keyFileNames(keysDir);
  const isAsFile = (f: string) => f.startsWith(AS_KEY_FILE_PREFIX);
  return {
    keys: existsNoFollow(registryMarkerPath(keysDir, "keys")) || files.some((f) => !isAsFile(f)),
    asKeys: existsNoFollow(registryMarkerPath(keysDir, "as-keys")) || files.some(isAsFile),
    tokens: existsNoFollow(registryMarkerPath(keysDir, "tokens")),
  };
}

/** Has this deployment ever used the registry (any part of it)? */
export function registryInitialized(keysDir: string): boolean {
  const s = registryInitState(keysDir);
  return s.keys || s.asKeys || s.tokens;
}

/** The operator-facing explanation of a lost registry, naming the recovery. `cause` says what is
 *  wrong; it defaults to a missing or empty auth.db. */
export function registryLostMessage(
  keysDir: string,
  cause = "auth.db is missing or empty",
): string {
  return (
    `the auth registry was initialised (${keysDir}) but ${cause}: revocations and key retirements ` +
    "are gone, so every token is refused rather than trusted. restore auth.db from backup. " +
    "Only if you accept that revoked tokens and retired keys become valid again, remove BOTH " +
    `auth.db and ${keysDir} to return to the configured auth.jwtSecret alone (destructive).`
  );
}

/** The lost-registry message for a state read from `registryInitState`. */
export function registryLostMessageFor(keysDir: string, state: RegistryInitState): string {
  return state.dirProblem !== undefined
    ? registryLostMessage(keysDir, `the keys directory is unusable (${state.dirProblem})`)
    : registryLostMessage(keysDir);
}

export function summarizeScopes(scopes: readonly string[]): string {
  const joined = scopes.join(",");
  return joined.length > 200 ? `${joined.slice(0, 200)}…` : joined;
}
