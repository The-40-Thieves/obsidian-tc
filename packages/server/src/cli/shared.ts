import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../db/migration-manifest";
import { embeddedSql } from "../db/migrations-embedded";
import {
  type parseCliArgs,
  type ResolvedServeConfig,
  resolveServeConfig,
  resolveServeConfigWithProvenance,
  USAGE,
} from "./args";

// The experiential.db chain, applied by every entry point that opens the store (serve +
// activation-recompute) so they can never diverge on schema. See migration-manifest.ts for the
// per-file ticket references (THE-222, THE-44, THE-239, THE-461).
// THE-578: inlined, not read from disk — see db/provision.ts for why. Under `bun build --compile`
// import.meta.url freezes to the build-time path and no .sql files are embedded, so this
// readFileSync was one of the two sites that made every published standalone binary unusable.
export const experientialMigrations = EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: embeddedSql(file),
}));
export type Cmd<K extends string> = Extract<ReturnType<typeof parseCliArgs>, { kind: K }>;

export function resolveOrUsageExit(input?: string): ServerConfig {
  try {
    return resolveServeConfig(input);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    process.exit(2);
  }
}

/** THE-825: same as `resolveOrUsageExit`, but also reports whether `plane.enabled` was explicit
 *  in the raw config — `run_serve` (cli.ts) needs this to gate the boot opt-in notice. */
export function resolveOrUsageExitWithProvenance(input?: string): ResolvedServeConfig {
  try {
    return resolveServeConfigWithProvenance(input);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    process.exit(2);
  }
}
