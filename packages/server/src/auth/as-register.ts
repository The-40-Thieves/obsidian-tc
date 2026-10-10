// `POST /oauth/register` of the bundled authorization server (RFC 7591; design v2 sections 4.3, 4.7, 8):
// Dynamic Client Registration, ON unless `auth.as.dynamicRegistration` is false (owner decision
// 2026-10-09: many MCP surfaces can only register this way; the route does not exist when off, and
// `hardened` forces the flag off). The MCP authorization spec deprecates DCR, and it hands anyone who
// can reach the server a way to create rows and to put a name in front of the operator, so it is
// bounded: a per-source rate limit (the CIMD source rule: the TCP peer, an IPv6 address as its /64,
// peers with no usable address sharing one bucket; a forwarded header only from a trusted proxy,
// client-ip.ts), a cap on registered clients, housekeeping for unused ones, public clients or
// `client_secret_basic` (a secret shown once, stored hashed) and one startup info line.
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Hono } from "hono";
import { MemoryBackend } from "../ratelimit/memory-backend";
import { cimdSourceKey } from "./as-cimd";
import { findStaticClient } from "./as-clients";
import {
  DCR_SECRET_METHOD,
  hashClientSecret,
  insertRegistration,
  newClientId,
  newClientSecret,
  parseRegistration,
} from "./as-dcr";
import { type AsRouteDeps, enabledAs } from "./as-metadata";
import { socketClientIp } from "./client-ip";

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
    "dynamic client registration (RFC 7591) is enabled: POST /oauth/register. " +
      `Limits: auth.as.dcr.perIpPerHour=${perIpPerHour} per source, auth.as.dcr.maxClients=${maxClients}, ` +
      `auth.as.dcr.unusedDays=${unusedDays}. Turn it off with auth.as.dynamicRegistration: false.`,
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
    const secret = parsed.meta.authMethod === DCR_SECRET_METHOD ? newClientSecret() : undefined;
    const stored = insertRegistration(db, {
      clientId,
      secretHash: secret === undefined ? undefined : hashClientSecret(secret),
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
        token_endpoint_auth_method: parsed.meta.authMethod,
        // RFC 7591 section 3.2.1: a secret comes with its expiry, 0 for none.
        ...(secret === undefined ? {} : { client_secret: secret, client_secret_expires_at: 0 }),
        grant_types: parsed.meta.grantTypes,
        response_types: ["code"],
        ...(parsed.meta.name === "" ? {} : { client_name: parsed.meta.name }),
      },
      201,
    );
  });
}
