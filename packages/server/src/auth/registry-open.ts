// The one place that opens `<cacheDir>/auth.db` for the server and the CLI, so serve, `token mint`
// and `auth *` cannot disagree about what a lost registry means.
//
// Order matters: whether the registry WAS initialised is decided from the markers/key files BEFORE
// the database is opened, because opening a missing SQLite file creates an empty one. A lost auth.db
// must never be silently replaced by a fresh empty database that then looks healthy.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { version as VERSION } from "../../package.json";
import { openConfiguredDatabase } from "../db/open";
import { provisionAuthDb } from "../db/provision";
import type { Database } from "../db/types";
import {
  ensureKeysDir,
  KeyFileError,
  keyFileNames,
  keysDirProblem,
  readKeyFile,
} from "./key-files";
import {
  type AuthKey,
  type AuthRegistry,
  authDbPath,
  authKeysDir,
  createAuthRegistry,
  createLostAuthRegistry,
  type RegistryHealth,
  registryInitState,
  registryLostMessageFor,
} from "./registry";

type RegistryCfg = Pick<ServerConfig, "cacheDir" | "db" | "auth">;

export interface OpenedAuthRegistry {
  registry: AuthRegistry;
  /** Release the auth.db handle (a no-op for a lost registry, which has none). */
  close(): void;
}

/**
 * Open (creating on first use) the auth registry. When the registry was initialised before but
 * auth.db is now missing, returns a registry that refuses every operation and does NOT create the
 * file; the caller reports `registry.health()`.
 */
export async function openAuthRegistry(
  cfg: RegistryCfg,
  opts: {
    now?: () => number;
    /** Persist `retiring` -> `retired` for windows that elapsed while nothing was running. Server
     *  start passes true; it is housekeeping (verification never depends on it) and best-effort. */
    reapRetired?: boolean;
  } = {},
): Promise<OpenedAuthRegistry> {
  const keysDir = authKeysDir(cfg.cacheDir);
  // `registryInitState` lstats auth-keys/ first: a symlink (even to an empty directory) counts as
  // initialised, so it is refused here instead of being recreated as a fresh, healthy-looking auth.db.
  const state = registryInitState(keysDir);
  if (!existsSync(authDbPath(cfg.cacheDir)) && (state.keys || state.tokens)) {
    return {
      registry: createLostAuthRegistry(keysDir, registryLostMessageFor(keysDir, state)),
      close: () => undefined,
    };
  }
  mkdirSync(cfg.cacheDir, { recursive: true });
  const db = await openConfiguredDatabase(cfg, "auth.db");
  try {
    provisionAuthDb(db, { version: VERSION });
  } catch (e) {
    db.close?.();
    throw e;
  }
  const registry = createAuthRegistry(db, {
    configSecret: cfg.auth.jwtSecret,
    keysDir,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  if (opts.reapRetired === true) {
    try {
      registry.reapRetired();
    } catch (e) {
      process.stderr.write(
        `auth: could not persist retired signing keys (verification is unaffected): ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
  return { registry, close: () => db.close?.() };
}

/** What `doctor` shows about the registry. Read-only: creates and changes nothing. */
export interface AuthRegistryProbe {
  health: RegistryHealth;
  dbPath: string;
  keysDir: string;
  /** One line per key file (or the directory) that fails the filesystem trust check. */
  keyFileIssues: string[];
  /** The registry's keys, or undefined when they cannot be read (no auth.db, or one not yet
   *  migrated to the current schema). Never key material. */
  keys?: AuthKey[];
}

export async function probeAuthRegistry(cfg: RegistryCfg): Promise<AuthRegistryProbe> {
  const keysDir = authKeysDir(cfg.cacheDir);
  const dbPath = authDbPath(cfg.cacheDir);
  const state = registryInitState(keysDir);
  let health: RegistryHealth =
    state.keys || state.tokens
      ? { state: "lost", detail: registryLostMessageFor(keysDir, state) }
      : { state: "uninitialised" };
  let keys: AuthKey[] | undefined;
  if (existsSync(dbPath)) {
    let db: Database | undefined;
    try {
      db = await openConfiguredDatabase(cfg, "auth.db", { readonly: true });
      const registry = createAuthRegistry(db, { keysDir });
      health = registry.health();
      keys = registry.listKeys();
    } catch {
      /* unreadable or unmigrated: the initialised/uninitialised reading above stands */
    } finally {
      db?.close?.();
    }
  }
  return {
    health,
    dbPath,
    keysDir,
    keyFileIssues: keyFileIssues(keysDir),
    ...(keys !== undefined ? { keys } : {}),
  };
}

function keyFileIssues(keysDir: string): string[] {
  // Before the empty-listing shortcut below: an empty directory behind a symlink lists as empty.
  const problem = keysDirProblem(keysDir);
  if (problem !== undefined) return [problem];
  const names = keyFileNames(keysDir);
  if (names.length === 0) return [];
  const issues: string[] = [];
  try {
    ensureKeysDir(keysDir, { create: false });
  } catch (e) {
    issues.push(e instanceof KeyFileError ? e.message : String(e));
    return issues;
  }
  for (const name of names) {
    try {
      readKeyFile(join(keysDir, name));
    } catch (e) {
      issues.push(e instanceof KeyFileError ? e.message : `${name}: ${String(e)}`);
    }
  }
  return issues;
}
