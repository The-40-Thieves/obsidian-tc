import { mkdirSync } from "node:fs";
import { listRegisteredClients, removeRegisteredClient } from "../../auth/as-client-admin";
import { enabledAs } from "../../auth/as-metadata";
import { openOauthDb } from "../../auth/oauth-db";
import { openAuthRegistry } from "../../auth/registry-open";
import { CliError } from "../cli-error";
import { type Cmd, resolveOrUsageExit } from "../shared";
import { auditAuthEvent } from "./auth-audit";

type Out = (human: string, json: unknown) => void;

function printClients(db: Parameters<typeof listRegisteredClients>[0], out: Out): void {
  const clients = listRegisteredClients(db);
  const iso = (ms: number | null) => (ms === null ? "-" : new Date(ms).toISOString());
  out(
    [
      "client\tcreated\tlast_used\texpires",
      ...clients.map((c) =>
        [c.clientId, iso(c.createdAt), iso(c.lastUsedAt), iso(c.expiresAt)].join("\t"),
      ),
    ].join("\n"),
    clients,
  );
}

export async function runAuthAsClients(cmd: Cmd<"auth">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.configPath);
  const as = enabledAs(cfg.auth);
  if (as === undefined) throw new CliError("auth.as is not enabled in this config");
  const out: Out = (human, json) =>
    process.stdout.write(cmd.json ? `${JSON.stringify(json, null, 2)}\n` : `${human}\n`);
  mkdirSync(cfg.cacheDir, { recursive: true, mode: 0o700 });
  const store = await openOauthDb(cfg);
  try {
    if (cmd.sub === "as-clients-list") {
      printClients(store.db, out);
      return;
    }
    const clientId = cmd.clientId as string;
    if (as.clients.some((c) => c.clientId === clientId) || /^https?:\/\//i.test(clientId)) {
      throw new CliError(
        "only dynamically registered clients can be removed; static clients belong in auth.as.clients and metadata-document clients are not registrations",
      );
    }
    const { registry, close } = await openAuthRegistry(cfg);
    try {
      const health = registry.health();
      if (health.state === "lost") throw new CliError(health.detail);
      const result = removeRegisteredClient(
        store.db,
        registry,
        clientId,
        cmd.reason ?? "client removed by operator",
        Date.now(),
      );
      if (result.status !== "removed")
        throw new CliError(
          `no removable DCR client ${clientId} (list them with: reliquary-tc auth as clients list)`,
        );
      await auditAuthEvent(cfg, "auth_client_removed");
      out(`removed client ${clientId}; revoked ${result.grants} grants`, { clientId, ...result });
    } finally {
      close();
    }
  } finally {
    store.close();
  }
}
