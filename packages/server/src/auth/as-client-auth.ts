// Client authentication shared by the token and revocation endpoints (design v2 sections 4.3 and
// 4.7): `none` for a public client, `client_secret_basic` for a confidential one. Both endpoints
// authenticate exactly the same way, so a client that can use one can use the other and neither
// can drift into accepting a credential the other refuses.
import type { Context } from "hono";
import { type AsClient, findStaticClient, secretsEqual } from "./as-clients";

/** `Authorization: Basic` as RFC 6749 section 2.3.1 defines it (form-urlencoded id and secret). */
function parseBasic(header: string | undefined): { id: string; secret: string } | undefined {
  const m = /^Basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(header ?? "");
  if (m === null) return undefined;
  const decoded = Buffer.from(m[1] as string, "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return undefined;
  try {
    return {
      id: decodeURIComponent(decoded.slice(0, i).replace(/\+/g, " ")),
      secret: decodeURIComponent(decoded.slice(i + 1).replace(/\+/g, " ")),
    };
  } catch {
    return undefined;
  }
}

/** The one value of a form field: undefined when absent, null when it was sent more than once. */
export type FormReader = (name: string) => string | undefined | null;
export const formReader =
  (form: URLSearchParams): FormReader =>
  (name) => {
    const all = form.getAll(name);
    return all.length > 1 ? null : all[0];
  };

/** Is this a form-encoded body (the only encoding either endpoint takes)? */
export const isFormRequest = (c: Context): boolean =>
  /^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(c.req.header("content-type") ?? "");

export type ClientAuthResult = { client: AsClient } | { failure: string };

/** Who is calling, or why not (the description for an `invalid_client` answer). */
export function authenticateClient(
  clients: Parameters<typeof findStaticClient>[0],
  form: URLSearchParams,
  authorization: string | undefined,
): ClientAuthResult {
  const one = formReader(form);
  const basic = parseBasic(authorization);
  const bodyId = one("client_id");
  if (bodyId === null || form.has("client_secret")) {
    return { failure: "client authentication is malformed" };
  }
  const clientId = basic?.id ?? bodyId;
  if (basic !== undefined && bodyId !== undefined && bodyId !== basic.id) {
    return { failure: "client authentication is malformed" };
  }
  const client = clientId === undefined ? undefined : findStaticClient(clients, clientId);
  if (client === undefined) return { failure: "unknown client" };
  if (client.secretEnv !== undefined) {
    const expected = process.env[client.secretEnv];
    if (basic === undefined || !expected || !secretsEqual(basic.secret, expected)) {
      return { failure: "client authentication failed" };
    }
  } else if (authorization !== undefined) {
    // A public client is bound to the `none` method: presenting credentials is a different client.
    return { failure: "this client does not authenticate" };
  }
  return { client };
}
