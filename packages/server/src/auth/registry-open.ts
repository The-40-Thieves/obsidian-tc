// The one place that opens `<cacheDir>/auth.db` for the server and the CLI, so serve, `token mint`
// and `auth *` cannot disagree about what a lost registry means.
//
// Order matters: whether the registry WAS initialised is decided from the sentinel/key files BEFORE
// the database is opened, because opening a missing SQLite file creates an empty one. A lost auth.db
// must never be silently replaced by a fresh empty database that then looks healthy.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { version as VERSION } from "../../package.json";
import { openConfiguredDatabase } from "../db/open";
import { provisionAuthDb } from "../db/provision";
import type { Database } from "../db/types";
import { ensureKeysDir, KeyFileError, keyFileNames, readKeyFile } from "./key-files";
import {
  type AuthRegistry,
  authDbPath,
  authKeysDir,
  createAuthRegistry,
  createLostAuthRegistry,
  type RegistryHealth,
  registryInitialized,
  registryLostMessage,
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
  opts: { now?: () => number } = {},
): Promise<OpenedAuthRegistry> {
  const keysDir = authKeysDir(cfg.cacheDir);
  if (!existsSync(authDbPath(cfg.cacheDir)) && registryInitialized(keysDir)) {
    return { registry: createLostAuthRegistry(keysDir), close: () => undefined };
  }
  mkdirSync(cfg.cacheDir, { recursive: true });
  const db = await openConfiguredDatabase(cfg, "auth.db");
  try {
    provisionAuthDb(db, { version: VERSION });
  } catch (e) {
    db.close?.();
    throw e;
  }
  return {
    registry: createAuthRegistry(db, {
      configSecret: cfg.auth.jwtSecret,
      keysDir,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    }),
    close: () => db.close?.(),
  };
}

/** What `doctor` shows about the registry. Read-only: creates and changes nothing. */
export interface AuthRegistryProbe {
  health: RegistryHealth;
  dbPath: string;
  keysDir: string;
  /** One line per key file (or the directory) that fails the filesystem trust check. */
  keyFileIssues: string[];
}

export async function probeAuthRegistry(cfg: RegistryCfg): Promise<AuthRegistryProbe> {
  const keysDir = authKeysDir(cfg.cacheDir);
  const dbPath = authDbPath(cfg.cacheDir);
  const initialised = registryInitialized(keysDir);
  let health: RegistryHealth = initialised
    ? { state: "lost", detail: registryLostMessage(keysDir) }
    : { state: "uninitialised" };
  if (existsSync(dbPath)) {
    let db: Database | undefined;
    try {
      db = await openConfiguredDatabase(cfg, "auth.db", { readonly: true });
      health = createAuthRegistry(db, { keysDir }).health();
    } catch {
      /* unreadable or unmigrated: the initialised/uninitialised reading above stands */
    } finally {
      db?.close?.();
    }
  }
  return { health, dbPath, keysDir, keyFileIssues: keyFileIssues(keysDir) };
}

function keyFileIssues(keysDir: string): string[] {
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
