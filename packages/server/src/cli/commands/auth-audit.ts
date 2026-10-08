// The audit row an `auth` CLI command leaves in cache.db's event_log (the audit store). The registry or
// oauth.db write is authoritative and already done when this runs; the audit row must not turn a
// completed revocation into an error, so a failure here is reported on stderr and swallowed.
import { mkdirSync } from "node:fs";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { version as VERSION } from "../../../package.json";
import { writeEvent } from "../../audit";
import { openConfiguredDatabase } from "../../db/open";
import { provisionCacheDb } from "../../db/provision";
import type { Database } from "../../db/types";

export async function auditAuthEvent(
  cfg: Pick<ServerConfig, "cacheDir" | "db">,
  event_type: string,
  caller: string | null = null,
): Promise<void> {
  let cache: Database | undefined;
  try {
    mkdirSync(cfg.cacheDir, { recursive: true });
    cache = await openConfiguredDatabase(cfg, "cache.db");
    provisionCacheDb(cache, { version: VERSION });
    writeEvent(cache, { ts: Date.now(), tool_name: null, caller, status: "ok", event_type });
  } catch (e) {
    process.stderr.write(
      `auth: ${event_type} done, but the audit event was not recorded: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  } finally {
    cache?.close?.();
  }
}
