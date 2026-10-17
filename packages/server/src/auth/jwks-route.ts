import { createHash } from "node:crypto";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Context, Hono } from "hono";
import type { AuthRegistry } from "./registry";

type AuthConfig = ServerConfig["auth"];

/** The longest a downstream cache may keep the published JWKS (seconds). */
const JWKS_MAX_AGE_SECONDS = 60;

/**
 * The JWKS document with a cache lifetime that cannot outlive a retiring key. This server stops
 * verifying a retiring key at its `retire_after`, so a cache holding the document past that instant
 * would keep advertising a key this server already refuses: `max-age` is capped at the whole seconds
 * left until the earliest retirement among the published keys, and a retirement under a second away
 * gets `no-cache` (revalidate every time). The ETag is a strong validator over the exact bytes served.
 * It cannot bound a retirement made AFTER a cache fetched (an immediate `rotate-key --grace 0`):
 * that is the residual `JWKS_MAX_AGE_SECONDS` already meant.
 */
function jwksResponse(
  c: Context,
  published: { jwks: { keys: unknown[] }; secondsUntilRetirement: number | null },
): Response {
  const body = JSON.stringify(published.jwks);
  const maxAge = Math.min(JWKS_MAX_AGE_SECONDS, published.secondsUntilRetirement ?? Infinity);
  const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
  const headers = {
    "cache-control": maxAge >= 1 ? `public, max-age=${maxAge}` : "no-cache",
    etag,
  };
  const matches = c.req
    .header("if-none-match")
    ?.split(",")
    .some((v) => {
      const tag = v.trim().replace(/^W\//, "");
      return tag === "*" || tag === etag;
    });
  if (matches === true) return new Response(null, { status: 304, headers });
  return c.newResponse(body, 200, { ...headers, "content-type": "application/json" });
}

export function mountJwksRoute(
  app: Hono,
  auth: AuthConfig,
  authRegistry: AuthRegistry | undefined,
): void {
  // JWKS of the registry's ES256/EdDSA signing keys, so a verifier that is not this process can
  // validate the tokens `token mint` issues. Public keys only, active and in-window retiring ones
  // (a retired key drops out at once). Unauthenticated by design, like the PRM above; nothing here
  // is secret. Not served for a lost registry: that refuses, it never publishes a partial set.
  if (auth.mode === "jwt" && authRegistry !== undefined) {
    const registry = authRegistry;
    app.get("/.well-known/jwks.json", (c) => {
      try {
        return jwksResponse(c, registry.publishedJwks());
      } catch {
        return c.json({ error: "signing keys unavailable" }, 503);
      }
    });
  }
}
