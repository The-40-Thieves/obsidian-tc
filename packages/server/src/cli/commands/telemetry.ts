// THE-1125 — `obsidian-tc telemetry preview|status|reset-id`. Opens cache.db directly (like
// metrics.ts/consolidate.ts) rather than booting a full server: none of the three subcommands need
// a running MCP server, only the config + the durable telemetry_state row.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { version as VERSION } from "../../../package.json";
import { openConfiguredDatabase } from "../../db/open";
import { provisionCacheDb } from "../../db/provision";
import { TelemetryCollector } from "../../telemetry/collector";
import { buildTelemetryDocument } from "../../telemetry/document";
import { redactEndpoint, redactEndpointWithPath } from "../../telemetry/redact-endpoint";
import { readTelemetryState, resetInstallId } from "../../telemetry/state";
import { defaultConfiguredFacadeMode } from "../../telemetry/wiring";
import { CliError } from "../cli-error";
import { type Cmd, resolveOrUsageExit } from "../shared";

export async function run_telemetry(cmd: Cmd<"telemetry">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.configPath);
  mkdirSync(cfg.cacheDir, { recursive: true });
  const db = await openConfiguredDatabase(cfg, "cache.db");
  provisionCacheDb(db, { version: VERSION });
  try {
    switch (cmd.sub) {
      case "preview": {
        // Security review (in-pool MEDIUM-C, decided): this CLI process has observed no tool
        // calls (there is no live server here) — counts are ALWAYS {} from this command, by
        // construction, regardless of how much traffic a running server has actually seen.
        // Persisting the live server's window to disk on every tick so this command could read it
        // back was considered and rejected (a real cross-process cost — a durable write per tool
        // call or per tick — for a CLI convenience command); this prints the exact DOCUMENT SHAPE
        // and the real install id, and says so explicitly. Real per-tool counts are visible from
        // `server_health`'s `telemetry` block or `doctor` on a RUNNING server instead.
        const collector = new TelemetryCollector();
        // Security review (in-pool LOW-H): the install id is created on first ENABLED send
        // (sendTelemetry's own getOrCreateInstallId call), never as a side effect of inspecting a
        // disabled config. When no row exists yet, show an EPHEMERAL id (never persisted).
        const installId = readTelemetryState(db)?.installId ?? randomUUID();
        const snap = collector.snapshot();
        const facadeMode = defaultConfiguredFacadeMode(cfg);
        const doc = buildTelemetryDocument({
          installId,
          serverVersion: VERSION,
          os: process.platform,
          arch: process.arch,
          facadeMode,
          clientNames: snap.clientNames,
          toolCalls: snap.toolCalls,
          errorCodes: snap.errorCodes,
          windowStart: snap.windowStart,
          windowEnd: snap.windowEnd,
        });
        process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
        process.stdout.write(
          "\n(document SHAPE and install id only — this CLI process has observed no tool calls, " +
            "so toolCalls/errorCodes/clientNames are always empty here; a running server's real " +
            "counts are in server_health's telemetry block or doctor)\n",
        );
        // Redacted by default (scheme+host — never userinfo/query, and config validation already
        // refuses userinfo in the endpoint outright); --show-path additionally shows the path,
        // which a collector convention can also use as a credential (e.g. "/ingest/<token>") —
        // see telemetry/redact-endpoint.ts's own header for why this is opt-in, not the default.
        const redact = cmd.showPath ? redactEndpointWithPath : redactEndpoint;
        process.stdout.write(
          `\nendpoint: ${cfg.telemetry.endpoint !== undefined ? redact(cfg.telemetry.endpoint) : "(none configured — telemetry.enabled must be false)"}\n`,
        );
        return;
      }
      case "status": {
        const state = readTelemetryState(db);
        const nextSendAt =
          cfg.telemetry.enabled && state?.lastSendAt != null
            ? state.lastSendAt + cfg.telemetry.intervalMinutes * 60_000
            : undefined;
        // Redacted (scheme+host ONLY — never the raw endpoint) — see redact-endpoint.ts.
        const status = {
          enabled: cfg.telemetry.enabled,
          endpoint:
            cfg.telemetry.endpoint !== undefined
              ? redactEndpoint(cfg.telemetry.endpoint)
              : undefined,
          intervalMinutes: cfg.telemetry.intervalMinutes,
          installId: state?.installId,
          lastSendAt: state?.lastSendAt ?? undefined,
          lastError: state?.lastError ?? undefined,
          nextSendAt,
        };
        if (cmd.json) {
          process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
          return;
        }
        process.stdout.write(
          `telemetry: ${status.enabled ? "enabled" : "disabled"}\n` +
            `endpoint: ${status.endpoint ?? "(none)"}\n` +
            `intervalMinutes: ${status.intervalMinutes}\n` +
            `installId: ${status.installId ?? "(not yet created)"}\n` +
            `lastSendAt: ${status.lastSendAt !== undefined ? new Date(status.lastSendAt).toISOString() : "(never)"}\n` +
            `lastError: ${status.lastError ?? "(none)"}\n` +
            `nextSendAt: ${status.nextSendAt !== undefined ? new Date(status.nextSendAt).toISOString() : "(n/a)"}\n`,
        );
        return;
      }
      case "reset-id": {
        const newId = resetInstallId(db);
        process.stdout.write(`telemetry install id reset: ${newId}\n`);
        return;
      }
      default:
        throw new CliError(`unknown telemetry subcommand: ${cmd.sub ?? "(none)"}`);
    }
  } finally {
    db.close?.();
  }
}
