// Transport and DNS seams for the public-URL doctor checks (doctor/public-url.ts). A hosted MCP
// client reaches the server the way this does: public DNS, a certificate verified against the system
// trust store, and no redirect followed. node:https is used rather than fetch because it exposes the
// peer certificate's expiry and the TLS error code, and because a redirect must be reported, never
// followed (the checks read the 3xx itself).
import dns from "node:dns/promises";
import https from "node:https";

export const PUBLIC_URL_TIMEOUT_MS = 5000;
/** A discovery document or challenge body is small; anything past this is not read. */
const MAX_BODY_BYTES = 64 * 1024;

/** A transport failure with the Node error code (`DEPTH_ZERO_SELF_SIGNED_CERT`, `ECONNREFUSED`,
 *  `ETIMEDOUT`, ...) so the checks can tell a certificate problem from an unreachable host. */
export class PublicUrlRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PublicUrlRequestError";
    this.code = code;
    Object.setPrototypeOf(this, PublicUrlRequestError.prototype);
  }
}

export interface PublicUrlRequestInit {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

export interface PublicUrlResponse {
  status: number;
  /** Lower-cased names; a repeated header is joined with ", ". */
  headers: Record<string, string>;
  body: string;
  /** Epoch ms the peer certificate expires, when the transport could read it. */
  certValidTo?: number | undefined;
}

export type PublicUrlRequest = (init: PublicUrlRequestInit) => Promise<PublicUrlResponse>;

/** What the probe needs from the outside world; tests inject all of it. */
export interface PublicUrlDeps {
  resolve4: (host: string) => Promise<string[]>;
  resolve6: (host: string) => Promise<string[]>;
  request: PublicUrlRequest;
  /** Wall-clock ms, for the certificate-expiry margin. */
  now?: () => number;
  /** Per-request and per-lookup deadline. */
  timeoutMs?: number;
}

export interface PublicUrlView {
  /** `auth.resource`: the URL hosted clients are given. */
  resource?: string | undefined;
  /** Present only under `--probe`. */
  probe?: PublicUrlDeps | undefined;
}

const flatten = (h: Record<string, string | string[] | undefined>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
};

/** HTTPS only, certificate verified, no redirect followed, a deadline and a body cap. */
export const publicUrlRequest: PublicUrlRequest = (init) =>
  new Promise<PublicUrlResponse>((resolve, reject) => {
    const u = new URL(init.url);
    if (u.protocol !== "https:") {
      reject(new PublicUrlRequestError("ENOTHTTPS", `${u.origin} is not an https URL`));
      return;
    }
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = https.request({
      protocol: "https:",
      hostname: u.hostname,
      port: u.port === "" ? 443 : Number(u.port),
      path: `${u.pathname}${u.search}`,
      method: init.method,
      headers: init.headers ?? {},
      rejectUnauthorized: true,
    });
    const timer = setTimeout(() => {
      req.destroy();
      done(() =>
        reject(
          new PublicUrlRequestError("ETIMEDOUT", `timed out after ${PUBLIC_URL_TIMEOUT_MS} ms`),
        ),
      );
    }, PUBLIC_URL_TIMEOUT_MS);
    timer.unref?.();
    req.on("error", (e: NodeJS.ErrnoException) =>
      done(() => reject(new PublicUrlRequestError(e.code ?? "EREQUEST", e.message))),
    );
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const peer = (
        res.socket as { getPeerCertificate?: () => { valid_to?: string } } | undefined
      )?.getPeerCertificate?.();
      const validTo = peer?.valid_to === undefined ? Number.NaN : Date.parse(peer.valid_to);
      const finish = () =>
        done(() =>
          resolve({
            status: res.statusCode ?? 0,
            headers: flatten(res.headers),
            body: Buffer.concat(chunks).toString("utf8"),
            ...(Number.isNaN(validTo) ? {} : { certValidTo: validTo }),
          }),
        );
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= MAX_BODY_BYTES) chunks.push(c);
      });
      res.on("end", finish);
      res.on("error", (e: NodeJS.ErrnoException) =>
        done(() => reject(new PublicUrlRequestError(e.code ?? "ERESPONSE", e.message))),
      );
    });
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });

/** The live probe: public DNS A / AAAA lookups (not getaddrinfo, which can answer from /etc/hosts or
 *  fall back to IPv6) and the verified transport above. */
export const defaultPublicUrlDeps: PublicUrlDeps = {
  resolve4: (host) => dns.resolve4(host),
  resolve6: (host) => dns.resolve6(host),
  request: publicUrlRequest,
};

/** The doctor view for `auth.resource`: a live probe only under `--probe`. */
export function publicUrlViewOf(resource: string | undefined, probe: boolean): PublicUrlView {
  return {
    ...(resource === undefined || resource === "" ? {} : { resource }),
    ...(resource !== undefined && resource !== "" && probe ? { probe: defaultPublicUrlDeps } : {}),
  };
}
