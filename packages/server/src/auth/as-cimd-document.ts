// Client ID Metadata Documents (design v2 section 4.7): the client_id is an https URL and the document
// served there is the client's registration. Everything the document says is untrusted input from a
// stranger, so this module accepts only the few fields the flow needs, normalises them, and refuses
// the rest of the document's claims (it is never stored whole, and `logo_uri`, `jwks_uri` and
// `client_uri` are never fetched or shown).
//
// Client authentication: the permitted methods are `token_endpoint_auth_methods_supported` when the
// document carries that list, and the singular `token_endpoint_auth_method` only when it does not.
// ChatGPT's document names `private_key_jwt` in the singular field while listing `none` as well, and
// an AS that reads only the singular field refuses it with `invalid_client` (HarperFast/oauth #244).
// The client is accepted iff the permitted set contains a method this server offers a CIMD client,
// which is `none` alone: a CIMD client has no secret to share and `private_key_jwt` is never advertised.
import { isLoopbackHost } from "@the-40-thieves/obsidian-tc-shared";
import { sanitizeDisplayText } from "../mcp/elicit-form";
import { isLoopbackUri } from "./as-clients";

/** What the flow keeps of a document. */
export interface ClientDocument {
  clientId: string;
  name: string;
  redirectUris: string[];
}

export type DocumentResult = { ok: true; doc: ClientDocument } | { ok: false; message: string };

export const CIMD_MAX_BYTES = 5 * 1024;
const CLIENT_ID_MAX = 2048;
const NAME_MAX = 100;
const REDIRECTS_MAX = 20;
/** The one method this server gives a CIMD client. */
export const CIMD_AUTH_METHOD = "none";

const refuse = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** The parsed client_id URL, or why it cannot be one: https, a path, no fragment, credentials or dot segments. */
export function parseClientIdUrl(clientId: string): URL | string {
  if (clientId.length > CLIENT_ID_MAX) return "the client_id URL is too long";
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return "the client_id is not a URL";
  }
  if (u.protocol !== "https:") return "the client_id URL must use https";
  if (u.username !== "" || u.password !== "") return "the client_id URL must not carry credentials";
  if (u.hash !== "" || clientId.includes("#")) return "the client_id URL must not have a fragment";
  if (u.pathname === "/" || u.pathname === "") return "the client_id URL must have a path";
  // Refused by name as well as by resolved address: `localhost` is this machine whatever a resolver says.
  if (isLoopbackHost(u.hostname) || u.hostname.endsWith(".localhost")) {
    return "the client_id URL must not name this machine";
  }
  // The URL parser resolves dot segments and lower-cases the host: a client_id that is not what it
  // parses to is a different string for the same document, which the exact-match rules must not allow.
  if (u.href !== clientId) {
    return "the client_id URL must be in canonical form (lower-case host, no dot segments or default port)";
  }
  return u;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** The methods the document permits, or undefined when it names none at all. `null` is a malformed field. */
function permittedMethods(d: Record<string, unknown>): string[] | undefined | null {
  const list = d.token_endpoint_auth_methods_supported;
  if (list !== undefined) return isStringArray(list) ? list : null;
  const one = d.token_endpoint_auth_method;
  if (one === undefined) return undefined;
  return typeof one === "string" ? [one] : null;
}

/** A redirect URI the flow can use: https, or http to a loopback host. Undefined: a private-use scheme, dropped. */
function usableRedirect(raw: string): string | undefined | "refuse" {
  if (raw === "" || raw.length > CLIENT_ID_MAX) return "refuse";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "refuse";
  }
  if (u.username !== "" || u.password !== "" || raw.includes("#")) return "refuse";
  if (u.protocol === "https:" && u.hostname !== "") return raw;
  if (isLoopbackUri(raw)) return raw;
  return undefined;
}

/** The name for the consent page: the display-text stripping the elicitation forms use (control, format
 *  and line-separator characters, so no bidi override or zero-width mark can reorder or hide it), then bounded. */
const cleanName = (raw: string): string =>
  sanitizeDisplayText(raw, Number.POSITIVE_INFINITY).trim().slice(0, NAME_MAX);

/**
 * Validate the body fetched from `clientId`. The document's own `client_id` must equal the URL it was
 * served from byte for byte, so one URL can never vouch for another.
 */
export function parseClientDocument(clientId: string, text: string): DocumentResult {
  const url = parseClientIdUrl(clientId);
  if (typeof url === "string") return refuse(url);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("the client metadata document is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("the client metadata document is not a JSON object");
  }
  const d = parsed as Record<string, unknown>;
  if (d.client_id !== clientId) {
    return refuse("the document's client_id is not the URL it was served from");
  }

  const methods = permittedMethods(d);
  if (methods === null) return refuse("token_endpoint_auth_method(s) are malformed");
  // Neither field: a public client that states no method is read as `none`, the method that grants
  // the least (PKCE is required whatever the document says).
  if (methods !== undefined && !methods.includes(CIMD_AUTH_METHOD)) {
    const named =
      methods.length === 0 ? "no method" : methods.map((m) => JSON.stringify(m)).join(", ");
    return refuse(
      `the client metadata document permits ${named} for token_endpoint_auth_method; this server accepts only "${CIMD_AUTH_METHOD}" from such a client`,
    );
  }

  if (d.grant_types !== undefined) {
    if (!isStringArray(d.grant_types) || !d.grant_types.includes("authorization_code")) {
      return refuse("grant_types must include authorization_code");
    }
  }
  if (d.response_types !== undefined) {
    if (!isStringArray(d.response_types) || !d.response_types.includes("code")) {
      return refuse("response_types must include code");
    }
  }

  const uris = d.redirect_uris;
  if (!isStringArray(uris) || uris.length === 0 || uris.length > REDIRECTS_MAX) {
    return refuse(`redirect_uris must be a list of 1 to ${REDIRECTS_MAX} URIs`);
  }
  const redirectUris: string[] = [];
  for (const raw of uris) {
    const kept = usableRedirect(raw);
    if (kept === "refuse")
      return refuse("a redirect_uri is not a valid URI without credentials or fragment");
    if (kept !== undefined && !redirectUris.includes(kept)) redirectUris.push(kept);
  }
  if (redirectUris.length === 0) {
    return refuse("none of the redirect_uris is an https or loopback URI");
  }

  if (d.client_name !== undefined && typeof d.client_name !== "string") {
    return refuse("client_name must be a string");
  }
  const name = typeof d.client_name === "string" ? cleanName(d.client_name) : "";
  return { ok: true, doc: { clientId, name: name || url.hostname, redirectUris } };
}
