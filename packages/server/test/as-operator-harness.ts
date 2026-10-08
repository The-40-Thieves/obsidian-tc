// Shared fixture for the operator-identity suites (slice S4): an in-memory oauth.db behind the real
// route mounter, a controllable clock, a log sink, and a tiny cookie jar. The module under test is
// imported lazily so a missing module fails each test for its own reason.
import { createHash } from "node:crypto";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { Hono } from "hono";
import { provisionOauthDb } from "../src/db/provision";
import { openMemoryDb } from "./helpers";

export const ISSUER = "https://vault.example.com";
export const RESOURCE = "https://vault.example.com/mcp";
export const SETUP_TOKEN = "setup-token-0123456789-abcdefghijkl";
export const PASSWORD = "correct horse battery staple";
export const T0 = 1_800_000_000_000;
export const MIN = 60_000;
export const SECRET = "test-only-server-secret-not-a-real-credential";

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export function authConfig(
  as: Record<string, unknown> = {},
  issuer: string = ISSUER,
): ServerConfig["auth"] {
  return ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: "/tmp/v1" }],
    auth: {
      mode: "jwt",
      jwtSecret: "test-only-secret-not-a-real-credential-0123456789",
      resource: RESOURCE,
      as: { enabled: true, issuer, ...as },
    },
  }).auth as ServerConfig["auth"];
}

/** Cookie jar: remembers Set-Cookie across responses, drops a cookie whose Max-Age is 0. */
export class Jar {
  readonly cookies = new Map<string, string>();
  apply(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = line.split(";").map((s) => s.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const dead = attrs.some((a) => /^max-age=0$/i.test(a)) || value === "";
      if (dead) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export interface OperatorFixture {
  app: Hono;
  db: ReturnType<typeof openMemoryDb>;
  clock: { t: number };
  logs: string[];
  env: Record<string, string | undefined>;
  /** Password hash and verify calls, so a test can see that an unknown user still costs one verify. */
  calls: { hash: number; verify: number };
  issuer: string;
  url: (path: string) => string;
}

export async function makeOperator(
  opts: {
    as?: Record<string, unknown>;
    issuer?: string;
    env?: Record<string, string | undefined>;
    verify?: (pw: string, phc: string) => Promise<boolean>;
    maxConcurrentHashes?: number;
  } = {},
): Promise<OperatorFixture> {
  const { mountAsOperator } = await import("../src/auth/as-operator");
  const pw = await import("../src/auth/as-password");
  const db = openMemoryDb();
  provisionOauthDb(db, { version: "t" });
  const clock = { t: T0 };
  const logs: string[] = [];
  const env = { OBSIDIAN_TC_AS_SETUP_TOKEN: SETUP_TOKEN, ...opts.env };
  const calls = { hash: 0, verify: 0 };
  const issuer = opts.issuer ?? ISSUER;
  const app = new Hono();
  mountAsOperator(app, {
    auth: authConfig(opts.as, issuer),
    db,
    secret: SECRET,
    now: () => clock.t,
    env,
    log: (line: string) => logs.push(line),
    // app.request has no socket, so the client address is a test header.
    clientIp: (c) => c.req.header("x-test-ip"),
    passwords: {
      hash: (p) => {
        calls.hash++;
        return pw.hashPassword(p);
      },
      verify: (p, phc) => {
        calls.verify++;
        return (opts.verify ?? pw.verifyPassword)(p, phc);
      },
    },
    ...(opts.maxConcurrentHashes !== undefined
      ? { maxConcurrentHashes: opts.maxConcurrentHashes }
      : {}),
  });
  return { app, db, clock, logs, env, calls, issuer, url: (path) => `${issuer}${path}` };
}

export const csrfOf = (html: string): string => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";

export interface Seen {
  res: Response;
  text: string;
  csrf: string;
}

export async function get(
  op: OperatorFixture,
  path: string,
  jar: Jar = new Jar(),
  headers: Record<string, string> = {},
): Promise<Seen> {
  const cookie = jar.header();
  const res = await op.app.request(op.url(path), {
    headers: { ...(cookie ? { cookie } : {}), ...headers },
  });
  jar.apply(res);
  const text = await res.text();
  return { res, text, csrf: csrfOf(text) };
}

/** POST a urlencoded form with the same-origin `Origin` a browser sends, unless overridden. */
export async function post(
  op: OperatorFixture,
  path: string,
  fields: Record<string, string>,
  jar: Jar = new Jar(),
  extra: { origin?: string | null; headers?: Record<string, string>; contentType?: string } = {},
): Promise<Seen> {
  const cookie = jar.header();
  const origin = extra.origin === undefined ? op.issuer : extra.origin;
  const res = await op.app.request(op.url(path), {
    method: "POST",
    headers: {
      "content-type": extra.contentType ?? "application/x-www-form-urlencoded",
      ...(origin !== null ? { origin } : {}),
      ...(cookie ? { cookie } : {}),
      ...extra.headers,
    },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
  jar.apply(res);
  const text = await res.text();
  return { res, text, csrf: csrfOf(text) };
}

/** Load a form page, then submit it with its own CSRF token and the jar it set. */
export async function submit(
  op: OperatorFixture,
  path: string,
  fields: Record<string, string>,
  jar: Jar = new Jar(),
  extra: Parameters<typeof post>[4] = {},
): Promise<Seen> {
  const form = await get(op, path, jar, extra.headers);
  return post(op, path, { csrf: form.csrf, ...fields }, jar, extra);
}

/** Claim the operator through the setup page and return a jar with no session in it. */
export async function claimViaSetup(
  op: OperatorFixture,
  username = "operator",
  password = PASSWORD,
): Promise<void> {
  const r = await submit(op, "/oauth/setup", {
    token: SETUP_TOKEN,
    username,
    password,
    confirm: password,
  });
  if (r.res.status !== 303)
    throw new Error(`claim failed: ${r.res.status} ${r.text.slice(0, 200)}`);
}

export async function login(
  op: OperatorFixture,
  jar: Jar,
  fields: Record<string, string> = { username: "operator", password: PASSWORD },
  extra: Parameters<typeof post>[4] = {},
): Promise<Seen> {
  return submit(op, "/oauth/login", fields, jar, extra);
}

export const sessionCookieName = (jar: Jar): string | undefined =>
  [...jar.cookies.keys()].find((k) => /otc_as$/.test(k));

export const userRows = (op: OperatorFixture) =>
  op.db.prepare("SELECT sub, username, password_hash, disabled_at FROM users").all() as Array<{
    sub: string;
    username: string;
    password_hash: string;
    disabled_at: number | null;
  }>;

export const sessionRows = (op: OperatorFixture) =>
  op.db.prepare("SELECT * FROM sessions").all() as Array<{
    id_hash: string;
    sub: string;
    created_at: number;
    last_seen_at: number;
    expires_at: number;
  }>;
