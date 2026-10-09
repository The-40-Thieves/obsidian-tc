// `POST /oauth/register` of the bundled authorization server (RFC 7591; design v2 sections 4.3, 4.7, 8):
// Dynamic Client Registration, OFF unless `auth.as.dynamicRegistration` is set (the route does not
// exist otherwise, and `hardened` forces the flag off). The MCP authorization spec deprecates DCR, and
// it hands anyone who can reach the server a way to create rows and to put a name in front of the
// operator, so it is bounded: a per-source rate limit (the CIMD source rule: the TCP peer, an IPv6
// address as its /64, peers with no usable address sharing one bucket; no forwarded header is read),
// a cap on registered clients, housekeeping for unused ones, public clients only and a boot notice.
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Hono } from "hono";
import { MemoryBackend } from "../ratelimit/memory-backend";
import { cimdSourceKey } from "./as-cimd";
import { findStaticClient } from "./as-clients";
import { DCR_AUTH_METHOD, insertRegistration, newClientId, parseRegistration } from "./as-dcr";
import { type AsRouteDeps, enabledAs } from "./as-metadata";
import { socketClientIp } from "./as-operator";

type AuthConfig = ServerConfig["auth"];

const HOUR_MS = 60 * 60_000;

const defaultLog = (line: string): void => {
  process.stderr.write(`[as] ${line}\n`);
};

export function mountRegisterRoute(app: Hono, auth: AuthConfig, deps?: AsRouteDeps): void {
  const as = enabledAs(auth);
  if (as === undefined || deps === undefined || !as.dynamicRegistration) return;
  const { db } = deps;
  const { maxClients, perIpPerHour, unusedDays } = as.dcr;
  const clientIp = deps.clientIp ?? socketClientIp;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? defaultLog;
  // A bucket that idled for less than its full refill time is not full, so the backend's default
  // sweep (10 minutes) would hand a source a fresh allowance mid-hour: keep them for two refills.
  const budgets = new MemoryBackend({ idleTtlMs: 2 * HOUR_MS });
  const budget = { capacity: perIpPerHour, refillTokens: perIpPerHour, intervalMs: HOUR_MS };

  log(
    "warning: dynamic client registration (RFC 7591) is ON: POST /oauth/register lets anyone who can " +
      "reach this server create OAuth clients. DCR is deprecated by the MCP authorization spec; " +
      "Claude, ChatGPT and Codex prefer Client ID Metadata Documents, which this server advertises, and do not need it. " +
      `Limits: auth.as.dcr.perIpPerHour=${perIpPerHour} per source, auth.as.dcr.maxClients=${maxClients}, ` +
      `auth.as.dcr.unusedDays=${unusedDays}. Turn auth.as.dynamicRegistration off unless a client needs it.`,
  );

  app.post("/oauth/register", async (c) => {
    c.header("cache-control", "no-store");
    c.header("pragma", "no-cache");
    // The budget comes before anything is read or parsed, and an invalid request spends it too.
    const source = cimdSourceKey(clientIp(c));
    const turn = await budgets.consume(`dcr:${source}`, budget, 1, now());
    if (!turn.ok) {
      log("client registrations refused: a source exceeded its budget");
      c.header("retry-after", String(Math.max(1, Math.ceil(turn.retryAfterMs / 1000))));
      return c.json(
        {
          error: "temporarily_unavailable",
          error_description: "too many registrations from this address; try again later",
        },
        429,
      );
    }
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) {
      return c.json(
        {
          error: "invalid_client_metadata",
          error_description: "send the registration as application/json",
        },
        415,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return c.json(
        { error: "invalid_client_metadata", error_description: "the registration is not JSON" },
        400,
      );
    }
    const parsed = parseRegistration(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error, error_description: parsed.description }, 400);
    }
    // The id is the server's: a `client_id` in the request is not read, so no registration can take a
    // static client's id or a metadata-document URL.
    let clientId = newClientId();
    while (findStaticClient(as.clients, clientId) !== undefined) clientId = newClientId();
    const issuedAt = now();
    const stored = insertRegistration(db, {
      clientId,
      meta: parsed.meta,
      source,
      now: issuedAt,
      maxClients,
    });
    if (stored === "full") {
      log("client registrations refused: the table is full");
      return c.json(
        {
          error: "temporarily_unavailable",
          error_description:
            "this server has reached its limit of registered clients; the operator can raise auth.as.dcr.maxClients, or unused registrations expire",
        },
        503,
      );
    }
    log(`client registered client=${clientId} source=${source}`);
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(issuedAt / 1000),
        redirect_uris: parsed.meta.redirectUris,
        token_endpoint_auth_method: DCR_AUTH_METHOD,
        grant_types: parsed.meta.grantTypes,
        response_types: ["code"],
        ...(parsed.meta.name === "" ? {} : { client_name: parsed.meta.name }),
      },
      201,
    );
  });
}
