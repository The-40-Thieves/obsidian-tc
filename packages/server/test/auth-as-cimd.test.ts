// Client ID Metadata Documents (slice S7; design v2 sections 4.7, 8, 9.1): conformance for the document
// shapes Claude Code, Codex and ChatGPT publish, the list-authoritative client-auth method, the
// SSRF and localhost-impersonation threat rows, the cache, and the consent warnings. The fetch and the
// resolver are injected, so nothing here touches the network; the one test that does not inject them
// proves the real path refuses a loopback target before opening a connection.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CIMD_SOURCE_BURST } from "../src/auth/as-cimd";
import { parseClientDocument } from "../src/auth/as-cimd-document";
import {
  authorize,
  basicAuth,
  cleanupFlows,
  consentPage,
  consentPost,
  exchange,
  type Flow,
  handleOf,
  issue,
  Jar,
  LOOPBACK_CLIENT,
  loginFor,
  makeFlow,
  obtainCode,
  pkce,
  refreshFields,
  revokeCall,
  rows,
  tokenFields,
} from "./as-flow-harness";

afterEach(cleanupFlows);

const MIN = 60_000;
const PUBLIC_IP = "93.184.216.34";

interface Page {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** A body that never ends, honouring the request's abort signal. */
  stall?: boolean;
}

/** A document site: URL -> response. Records every fetch and every name resolved. */
function site(pages: Record<string, Page | (() => Page)>, addresses?: (host: string) => string[]) {
  const fetched: string[] = [];
  const resolved: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const key = String(url);
    fetched.push(key);
    const entry = pages[key];
    const page = typeof entry === "function" ? entry() : entry;
    if (page === undefined) return new Response("not found", { status: 404 });
    if (page.stall) {
      const signal = init?.signal;
      const body = new ReadableStream({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(signal.reason));
        },
      });
      return new Response(body, { status: page.status ?? 200 });
    }
    return new Response(page.body ?? "", { status: page.status ?? 200, headers: page.headers });
  }) as typeof fetch;
  const resolveHost = async (host: string): Promise<string[]> => {
    resolved.push(host);
    return addresses ? addresses(host) : [PUBLIC_IP];
  };
  return { fetched, resolved, seam: { fetch: fetchImpl, resolveHost } };
}

const json = (doc: unknown, headers?: Record<string, string>): Page => ({
  body: JSON.stringify(doc),
  headers: { "content-type": "application/json", ...headers },
});

// ---- the documents -------------------------------------------------------------------------------

const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
const claudeCodeDoc = {
  client_id: CLAUDE_CODE,
  client_name: "Claude Code",
  client_uri: "https://claude.com/product/claude-code",
  redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

const CODEX = "https://openai.com/codex/oauth-client.json";
const codexDoc = {
  client_id: CODEX,
  client_name: "Codex CLI",
  redirect_uris: ["http://127.0.0.1:1455/auth/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

// ChatGPT's real shape (HarperFast/oauth issue 244): the singular field prefers private_key_jwt and
// the list carries both, with the keys and logo it points at.
const CHATGPT = "https://chatgpt.com/oauth/client-metadata.json";
const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const chatgptDoc = {
  client_id: CHATGPT,
  client_name: "ChatGPT",
  logo_uri: "https://chatgpt.com/logo.png",
  jwks_uri: "https://chatgpt.com/.well-known/jwks.json",
  redirect_uris: [CHATGPT_REDIRECT],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "private_key_jwt",
  token_endpoint_auth_methods_supported: ["private_key_jwt", "none"],
};

async function cimdFlow(
  pages: Record<string, Page | (() => Page)>,
  opts: {
    allowedHosts?: string[];
    addresses?: (host: string) => string[];
    timeoutMs?: number;
    maxCacheRows?: number;
  } = {},
) {
  const s = site(pages, opts.addresses);
  const flow = await makeFlow({
    ...(opts.allowedHosts ? { as: { cimd: { allowedHosts: opts.allowedHosts } } } : {}),
    cimd: {
      ...s.seam,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.maxCacheRows ? { maxCacheRows: opts.maxCacheRows } : {}),
    },
  });
  return { flow, ...s };
}

const cacheRows = (flow: Flow) => rows<{ client_id: string }>(flow, "SELECT * FROM cimd_cache");
const { challenge } = pkce();

/** authorize with a CIMD client; the response is a local error (400, no Location) or a redirect. */
const authorizeAs = (
  flow: Flow,
  clientId: string,
  redirectUri: string,
  jar = new Jar(),
  over: Record<string, string | undefined> = {},
) => authorize(flow, jar, challenge, { client_id: clientId, redirect_uri: redirectUri, ...over });

async function expectRefusedLocally(res: Response, containing?: string): Promise<void> {
  expect(res.status).toBe(400);
  expect(res.headers.get("location")).toBeNull();
  if (containing !== undefined) expect(await res.text()).toContain(containing);
}

// ---- conformance ----------------------------------------------------------------------------------

describe("conformance: authorize -> consent -> token -> refresh -> revoke for a CIMD client", () => {
  it.each([
    ["Claude Code", CLAUDE_CODE, claudeCodeDoc, "http://127.0.0.1:53124/callback"],
    ["Claude Code on localhost", CLAUDE_CODE, claudeCodeDoc, "http://localhost:41999/callback"],
    ["Codex", CODEX, codexDoc, "http://127.0.0.1:1455/auth/callback"],
  ])("%s", async (_name, clientId, doc, redirect) => {
    const { flow, fetched } = await cimdFlow({ [clientId]: json(doc) });
    const issued = await issue(flow, { client_id: clientId, redirect_uri: redirect });
    expect(issued.body.token_type).toBe("Bearer");
    expect(fetched).toEqual([clientId]);
    const again = await exchange(
      flow,
      refreshFields(issued.refresh, { client_id: clientId, resource: undefined }),
    );
    expect(again.res.status).toBe(200);
    const next = again.body.refresh_token as string;
    expect(next).not.toBe(issued.refresh);
    const revoked = await revokeCall(flow, { token: next, client_id: clientId });
    expect(revoked.res.status).toBe(200);
    const dead = await exchange(
      flow,
      refreshFields(next, { client_id: clientId, resource: undefined }),
    );
    expect(dead.body.error).toBe("invalid_grant");
  });

  it("ChatGPT's real document shape resolves to `none` and completes the flow (not invalid_client)", async () => {
    const { flow, fetched } = await cimdFlow({ [CHATGPT]: json(chatgptDoc) });
    const issued = await issue(flow, { client_id: CHATGPT, redirect_uri: CHATGPT_REDIRECT });
    expect(issued.body.access_token).toBeTruthy();
    // jwks_uri and logo_uri are named by the document and never fetched (design 4.7).
    expect(fetched).toEqual([CHATGPT]);
  });

  it("a CIMD client is bound to `none`: any other client authentication is invalid_client", async () => {
    const { flow } = await cimdFlow({ [CHATGPT]: json(chatgptDoc) });
    const attempt = async (headers: Record<string, string>, extra: Record<string, string> = {}) => {
      const { verifier, challenge: ch } = pkce();
      const { code } = await obtainCode(flow, new Jar(), ch, {
        client_id: CHATGPT,
        redirect_uri: CHATGPT_REDIRECT,
      });
      return exchange(
        flow,
        tokenFields(code, verifier, {
          client_id: CHATGPT,
          redirect_uri: CHATGPT_REDIRECT,
          ...extra,
        }),
        headers,
      );
    };
    const basic = await attempt(basicAuth(CHATGPT, "x"));
    expect(basic.res.status).toBe(401);
    expect(basic.body.error).toBe("invalid_client");
    const assertion = await attempt(
      {},
      {
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: "a.b.c",
      },
    );
    expect(assertion.res.status).toBe(401);
    expect(assertion.body.error).toBe("invalid_client");
    expect((await attempt({})).res.status).toBe(200);
  });

  it("advertises client_id_metadata_document_supported now that resolution exists", async () => {
    const { flow } = await cimdFlow({});
    const meta = (await (
      await flow.app.request(flow.url("/.well-known/oauth-authorization-server"))
    ).json()) as Record<string, unknown>;
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.token_endpoint_auth_methods_supported).toContain("none");
    expect(JSON.stringify(meta)).not.toContain("private_key_jwt");
  });

  it("a static client wins over a URL lookup and a name that is neither is unknown", async () => {
    const { flow, fetched } = await cimdFlow({});
    const res = await authorize(flow, new Jar(), challenge, { client_id: "nobody" });
    await expectRefusedLocally(res, "not registered");
    expect(fetched).toEqual([]);
    const ok = await authorize(flow, new Jar(), challenge);
    expect(ok.status).toBe(303);
    expect(fetched).toEqual([]);
  });
});

// ---- the list is authoritative ---------------------------------------------------------------------

describe("client-auth method: the list is authoritative", () => {
  const base = { client_id: "https://c.example/doc", redirect_uris: ["https://c.example/cb"] };
  const parse = (extra: Record<string, unknown>) =>
    parseClientDocument(base.client_id, JSON.stringify({ ...base, ...extra }));

  it("ChatGPT's shape (singular private_key_jwt, list [private_key_jwt, none]) is accepted", () => {
    expect(
      parse({
        token_endpoint_auth_method: "private_key_jwt",
        token_endpoint_auth_methods_supported: ["private_key_jwt", "none"],
      }).ok,
    ).toBe(true);
  });

  it("the singular field is consulted only when the list is absent", () => {
    expect(parse({ token_endpoint_auth_method: "none" }).ok).toBe(true);
    // A singular `none` does not rescue a list that excludes it.
    const r = parse({
      token_endpoint_auth_method: "none",
      token_endpoint_auth_methods_supported: ["private_key_jwt"],
    });
    expect(r.ok).toBe(false);
  });

  it("a private_key_jwt-only document is refused, naming the method", () => {
    for (const extra of [
      { token_endpoint_auth_methods_supported: ["private_key_jwt"] },
      { token_endpoint_auth_method: "private_key_jwt" },
      { token_endpoint_auth_methods_supported: ["client_secret_basic", "private_key_jwt"] },
    ]) {
      const r = parse(extra);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("private_key_jwt");
    }
    // An empty list permits nothing.
    expect(parse({ token_endpoint_auth_methods_supported: [] }).ok).toBe(false);
  });

  it("a malformed list is refused rather than read as the singular field", () => {
    expect(parse({ token_endpoint_auth_methods_supported: "none" }).ok).toBe(false);
    expect(parse({ token_endpoint_auth_methods_supported: [1] }).ok).toBe(false);
  });

  it("over HTTP: a private_key_jwt-only document is refused at authorize and at the token endpoint", async () => {
    const id = "https://jwt.example/client.json";
    const doc = {
      client_id: id,
      client_name: "Keyed",
      redirect_uris: ["https://jwt.example/cb"],
      token_endpoint_auth_methods_supported: ["private_key_jwt"],
    };
    const { flow } = await cimdFlow({ [id]: json(doc) });
    // The page says only that the client cannot be used; the reason is for the log.
    const page = await authorizeAs(flow, id, "https://jwt.example/cb");
    await expectRefusedLocally(page);
    expect(flow.logs.join("\n")).toContain("private_key_jwt");
    const { res, body } = await exchange(flow, tokenFields("c", "v".repeat(43), { client_id: id }));
    expect(res.status).toBe(401);
    expect(body.error).toBe("invalid_client");
    expect(String(body.error_description)).toContain("private_key_jwt");
  });
});

// ---- document validation ---------------------------------------------------------------------------

describe("document validation", () => {
  const ID = "https://c.example/doc";
  const good = { client_id: ID, client_name: "C", redirect_uris: ["https://c.example/cb"] };
  const parse = (doc: unknown) =>
    parseClientDocument(ID, typeof doc === "string" ? doc : JSON.stringify(doc));

  it("accepts a minimal document and defaults the name to the host", () => {
    const r = parse({ client_id: ID, redirect_uris: ["https://c.example/cb"] });
    expect(r).toMatchObject({ ok: true, doc: { clientId: ID, name: "c.example" } });
  });

  it.each([
    ["not JSON", "<html>"],
    ["an array", "[]"],
    ["a client_id that differs", { ...good, client_id: "https://c.example/other" }],
    ["no client_id", { redirect_uris: good.redirect_uris }],
    ["no redirect_uris", { client_id: ID }],
    ["empty redirect_uris", { ...good, redirect_uris: [] }],
    ["redirect_uris that is not an array", { ...good, redirect_uris: "https://c.example/cb" }],
    ["a redirect_uri that is not a string", { ...good, redirect_uris: [1] }],
    ["a redirect_uri with a fragment", { ...good, redirect_uris: ["https://c.example/cb#x"] }],
    ["a redirect_uri with credentials", { ...good, redirect_uris: ["https://u:p@c.example/cb"] }],
    ["only an http non-loopback redirect_uri", { ...good, redirect_uris: ["http://c.example/cb"] }],
    ["only a javascript: redirect_uri", { ...good, redirect_uris: ["javascript:alert(1)"] }],
    ["grant_types without authorization_code", { ...good, grant_types: ["implicit"] }],
    ["response_types without code", { ...good, response_types: ["token"] }],
    ["a name that is not a string", { ...good, client_name: { x: 1 } }],
  ])("refuses %s", (_what, doc) => {
    expect(parse(doc).ok).toBe(false);
  });

  it("keeps the usable redirect URIs and drops private-use ones, as DCR does", () => {
    const r = parse({ ...good, redirect_uris: ["cursor://cb", "https://c.example/cb"] });
    expect(r).toMatchObject({ ok: true, doc: { redirectUris: ["https://c.example/cb"] } });
  });

  it("strips control characters from the name and bounds its length", () => {
    const r = parse({ ...good, client_name: `Evil\u0000\n${"x".repeat(500)}` });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([...r.doc.name].every((ch) => (ch.codePointAt(0) ?? 0) >= 0x20)).toBe(true);
      expect(r.doc.name.length).toBeLessThanOrEqual(100);
    }
  });

  it("refuses a client_id that is not an https URL with a path, no fragment, no dot segments", () => {
    for (const id of [
      "http://c.example/doc",
      "https://c.example",
      "https://c.example/",
      "https://c.example/doc#frag",
      "https://u:p@c.example/doc",
      "https://c.example/a/../doc",
      "https://c.example/./doc",
      "ftp://c.example/doc",
      "not a url",
    ]) {
      const r = parseClientDocument(id, JSON.stringify({ ...good, client_id: id }));
      expect(r.ok, id).toBe(false);
    }
  });

  it("over HTTP: a refused document is a local error page, never a redirect", async () => {
    const { flow } = await cimdFlow({
      [ID]: json({ ...good, client_id: "https://c.example/other" }),
    });
    await expectRefusedLocally(await authorizeAs(flow, ID, "https://c.example/cb"));
    expect(cacheRows(flow)).toEqual([]);
  });
});

// ---- SSRF ------------------------------------------------------------------------------------------

describe("CIMD SSRF", () => {
  const redirect = "https://c.example/cb";
  const doc = (id: string) => ({ client_id: id, client_name: "C", redirect_uris: [redirect] });

  it.each([
    ["loopback", "127.0.0.1"],
    ["cloud metadata", "169.254.169.254"],
    ["RFC 1918", "10.0.0.5"],
    ["carrier-grade NAT", "100.64.0.1"],
    ["IPv6 loopback", "::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["unique-local", "fd00::1"],
    ["a rebinding answer mixing public and private", PUBLIC_IP],
  ])("a name that resolves to %s is refused before any request", async (what, address) => {
    const id = "https://evil.example/client.json";
    const mixed = what.startsWith("a rebinding");
    const { flow, fetched, resolved } = await cimdFlow(
      { [id]: json(doc(id)) },
      { addresses: () => (mixed ? [PUBLIC_IP, "10.0.0.5"] : [address]) },
    );
    await expectRefusedLocally(await authorizeAs(flow, id, redirect));
    expect(resolved).toEqual(["evil.example"]);
    expect(fetched).toEqual([]);
  });

  it.each([
    "https://127.0.0.1/client.json",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/client.json",
    "https://[::1]/client.json",
    "https://[::ffff:7f00:1]/client.json",
    "https://0x7f.1/client.json",
  ])("a literal-address client_id %s is refused before any request", async (id) => {
    const { flow, fetched } = await cimdFlow({ [id]: json(doc(id)) });
    await expectRefusedLocally(await authorizeAs(flow, id, redirect));
    expect(fetched).toEqual([]);
  });

  it("DNS rebinding: a name that was public and later flips to a private address is refused at the next fetch", async () => {
    const id = "https://flip.example/client.json";
    let calls = 0;
    const { flow, fetched } = await cimdFlow(
      { [id]: json(doc(id), { "cache-control": "max-age=300" }) },
      { addresses: () => (++calls === 1 ? [PUBLIC_IP] : ["127.0.0.1"]) },
    );
    expect((await authorizeAs(flow, id, redirect)).status).toBe(303);
    flow.clock.t += 6 * MIN;
    await expectRefusedLocally(await authorizeAs(flow, id, redirect));
    expect(fetched).toEqual([id]);
  });

  it("the connection is made to the validated addresses, never the name again (no private-network opt-in)", async () => {
    // The real path: no injected fetch and no injected resolver. A name that is a loopback literal
    // is refused before a socket is opened, so the listener sees nothing.
    let connections = 0;
    const server = createServer(() => {
      connections++;
    });
    server.on("connection", () => {
      connections++;
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const flow = await makeFlow();
      for (const id of [`https://127.0.0.1:${port}/client.json`, "https://localhost/client.json"]) {
        await expectRefusedLocally(await authorizeAs(flow, id, redirect));
      }
      expect(connections).toBe(0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("an http:// client_id is refused before any request", async () => {
    const id = "http://c.example/client.json";
    const { flow, fetched, resolved } = await cimdFlow({ [id]: json(doc(id)) });
    await expectRefusedLocally(await authorizeAs(flow, id, redirect));
    expect(fetched).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it.each([301, 302, 307, 308])(
    "a client_id that answers %i is refused: redirects are not followed",
    async (status) => {
      const id = "https://redir.example/client.json";
      const { flow, fetched } = await cimdFlow({
        [id]: { status, headers: { location: "http://169.254.169.254/latest/meta-data" } },
        "http://169.254.169.254/latest/meta-data": json(doc(id)),
      });
      await expectRefusedLocally(await authorizeAs(flow, id, redirect));
      expect(fetched).toEqual([id]);
    },
  );

  it("a 6 KiB body is refused (5 KiB cap), whether or not it declares its length", async () => {
    const id = "https://big.example/client.json";
    const pad = JSON.stringify({ ...doc(id), pad: "x".repeat(6 * 1024) });
    const sizes: Array<Record<string, string>> = [{}, { "content-length": String(pad.length) }];
    for (const headers of sizes) {
      const { flow } = await cimdFlow({ [id]: { body: pad, headers } });
      await expectRefusedLocally(await authorizeAs(flow, id, redirect));
      expect(cacheRows(flow)).toEqual([]);
    }
  });

  it("a body that stalls is cut off by the timeout and nothing is cached", async () => {
    const id = "https://slow.example/client.json";
    const { flow } = await cimdFlow({ [id]: { stall: true } }, { timeoutMs: 100 });
    await expectRefusedLocally(await authorizeAs(flow, id, redirect));
    expect(cacheRows(flow)).toEqual([]);
  });

  it("a 500 followed by a success: the error is not cached", async () => {
    const id = "https://flaky.example/client.json";
    let up = false;
    const { flow, fetched } = await cimdFlow({
      [id]: () => (up ? json(doc(id)) : { status: 500, body: "oops" }),
    });
    await expectRefusedLocally(await authorizeAs(flow, id, redirect));
    expect(cacheRows(flow)).toEqual([]);
    up = true;
    expect((await authorizeAs(flow, id, redirect)).status).toBe(303);
    expect(fetched).toEqual([id, id]);
  });

  it("a refused document (wrong client_id) is not cached either", async () => {
    const id = "https://liar.example/client.json";
    const { flow, fetched } = await cimdFlow({
      [id]: json({ ...doc(id), client_id: "https://other.example/client.json" }),
    });
    await expectRefusedLocally(await authorizeAs(flow, id, redirect));
    await expectRefusedLocally(await authorizeAs(flow, id, redirect));
    expect(fetched).toEqual([id, id]);
    expect(cacheRows(flow)).toEqual([]);
  });

  it("allowedHosts: a host that is not listed is refused before any request; a listed one is served", async () => {
    const ok = "https://claude.ai/oauth/client.json";
    const bad = "https://claude.ai.evil.example/oauth/client.json";
    const other = "https://elsewhere.example/oauth/client.json";
    const { flow, fetched, resolved } = await cimdFlow(
      { [ok]: json(doc(ok)), [bad]: json(doc(bad)), [other]: json(doc(other)) },
      { allowedHosts: ["claude.ai"] },
    );
    for (const id of [bad, other])
      await expectRefusedLocally(await authorizeAs(flow, id, redirect));
    expect(fetched).toEqual([]);
    expect(resolved).toEqual([]);
    expect((await authorizeAs(flow, ok, redirect)).status).toBe(303);
    // The URL parser lower-cases the host, so the list is matched case-insensitively.
    const upper = "https://CLAUDE.ai/oauth/client.json";
    expect(new URL(upper).hostname).toBe("claude.ai");
  });

  it("allowedHosts also guards the token endpoint", async () => {
    const id = "https://claude.ai/oauth/client.json";
    const { flow } = await cimdFlow(
      { [id]: json(doc(id)) },
      { allowedHosts: ["elsewhere.example"] },
    );
    const { res, body } = await exchange(flow, tokenFields("c", "v".repeat(43), { client_id: id }));
    expect(res.status).toBe(401);
    expect(body.error).toBe("invalid_client");
  });
});

// ---- localhost impersonation -----------------------------------------------------------------------

describe("localhost impersonation", () => {
  it("consent for a loopback-only CIMD client carries the loud warning and names the client_id host", async () => {
    const { flow } = await cimdFlow({ [CLAUDE_CODE]: json(claudeCodeDoc) });
    const jar = new Jar();
    const a = await authorizeAs(flow, CLAUDE_CODE, "http://127.0.0.1:53124/callback", jar);
    const next = a.headers.get("location") ?? "";
    await loginFor(flow, jar, next);
    const page = await consentPage(flow, jar, handleOf(next));
    expect(page.seen.text).toContain("returns to an address on the computer");
    expect(page.seen.text).toContain("claude.ai");
    expect(page.seen.text).toContain("Claude Code");
    // Never approved before: the second warning.
    expect(page.seen.text).toContain("you have not approved it before");
  });

  it("a hosted CIMD client gets the never-approved warning but not the loopback one, and it ends once approved", async () => {
    const { flow } = await cimdFlow({ [CHATGPT]: json(chatgptDoc) });
    const jar = new Jar();
    const first = await authorizeAs(flow, CHATGPT, CHATGPT_REDIRECT, jar, { scope: "read:notes" });
    const next = first.headers.get("location") ?? "";
    await loginFor(flow, jar, next);
    const page = await consentPage(flow, jar, handleOf(next));
    expect(page.seen.text).toContain("you have not approved it before");
    expect(page.seen.text).not.toContain("returns to an address on the computer");
    expect(page.seen.text).toContain("chatgpt.com");
    const done = await consentPost(flow, jar, {
      csrf: page.csrf,
      request: page.request,
      decision: "approve",
    });
    expect(done.res.status).toBe(303);
    // A wider scope asks again, and the operator has approved this client by now.
    const second = await authorizeAs(flow, CHATGPT, CHATGPT_REDIRECT, jar, {
      scope: "read:notes write:notes",
    });
    const page2 = await consentPage(flow, jar, handleOf(second.headers.get("location")));
    expect(page2.seen.res.status).toBe(200);
    expect(page2.seen.text).not.toContain("you have not approved it before");
  });

  it("a static client's consent page has no never-approved warning", async () => {
    const { flow } = await cimdFlow({});
    const jar = new Jar();
    const a = await authorize(flow, jar, challenge);
    const next = a.headers.get("location") ?? "";
    await loginFor(flow, jar, next);
    const page = await consentPage(flow, jar, handleOf(next));
    expect(page.seen.text).not.toContain("you have not approved it before");
  });

  it("the client's own name is escaped on the consent page", async () => {
    const id = "https://xss.example/client.json";
    const { flow } = await cimdFlow({
      [id]: json({
        client_id: id,
        client_name: "<script>alert(1)</script>",
        redirect_uris: ["https://xss.example/cb"],
      }),
    });
    const jar = new Jar();
    const a = await authorizeAs(flow, id, "https://xss.example/cb", jar);
    const next = a.headers.get("location") ?? "";
    await loginFor(flow, jar, next);
    const page = await consentPage(flow, jar, handleOf(next));
    expect(page.seen.text).not.toContain("<script>alert(1)");
    expect(page.seen.text).toContain("&lt;script&gt;");
  });

  it("a redirect that only looks like the loopback one is refused, and no redirect happens", async () => {
    const { flow } = await cimdFlow({ [CLAUDE_CODE]: json(claudeCodeDoc) });
    for (const uri of [
      "http://localhost.evil.example/callback",
      "http://127.0.0.1.evil.example/callback",
      "https://localhost/callback",
      "http://localhost/other",
      "http://evil.example/callback",
    ]) {
      await expectRefusedLocally(await authorizeAs(flow, CLAUDE_CODE, uri));
    }
  });

  it("a document that claims only a non-loopback http redirect is refused outright", async () => {
    const id = "https://squat.example/client.json";
    const { flow } = await cimdFlow({
      [id]: json({ client_id: id, redirect_uris: ["http://squat.example/cb"] }),
    });
    await expectRefusedLocally(await authorizeAs(flow, id, "http://squat.example/cb"));
  });

  it("a client_id that claims localhost as its host is refused (it cannot be fetched)", async () => {
    const { flow, fetched } = await cimdFlow({});
    for (const id of ["https://localhost/client.json", "https://localhost:8443/client.json"]) {
      await expectRefusedLocally(await authorizeAs(flow, id, "http://localhost/callback"));
    }
    expect(fetched).toEqual([]);
  });
});

// ---- cache -----------------------------------------------------------------------------------------

describe("cache", () => {
  const id = "https://cache.example/client.json";
  const redirect = "https://cache.example/cb";
  const doc = { client_id: id, client_name: "Cached", redirect_uris: [redirect] };

  it.each([
    ["no Cache-Control: 5 minutes", undefined, 5 * MIN],
    ["max-age=1 is raised to 5 minutes", "max-age=1", 5 * MIN],
    ["max-age=3600 is honoured", "public, max-age=3600", 60 * MIN],
    ["max-age=999999 is cut to 24 hours", "max-age=999999", 24 * 60 * MIN],
    ["no-store is still held for the 5-minute floor", "no-store", 5 * MIN],
    ["garbage falls back to 5 minutes", "max-age=abc", 5 * MIN],
  ])("%s", async (_what, header, ttl) => {
    const { flow, fetched } = await cimdFlow({
      [id]: json(doc, header === undefined ? {} : { "cache-control": header }),
    });
    expect((await authorizeAs(flow, id, redirect)).status).toBe(303);
    expect(cacheRows(flow)).toHaveLength(1);
    flow.clock.t += ttl - 1000;
    await authorizeAs(flow, id, redirect);
    expect(fetched).toHaveLength(1);
    flow.clock.t += 2000;
    await authorizeAs(flow, id, redirect);
    expect(fetched).toHaveLength(2);
  });

  it("stores the validated document, not the raw body (so a hostile field is never kept)", async () => {
    const { flow } = await cimdFlow({
      [id]: json({ ...doc, logo_uri: "https://cache.example/logo.png", junk: "x".repeat(1000) }),
    });
    await authorizeAs(flow, id, redirect);
    const stored = rows<{ document_json: string }>(flow, "SELECT document_json FROM cimd_cache");
    expect(stored[0]?.document_json).not.toContain("junk");
    expect(stored[0]?.document_json).not.toContain("logo_uri");
  });

  it("one client_id's document can never answer for another: a document naming someone else's id is refused and the victim's entry is untouched", async () => {
    const victim = "https://victim.example/client.json";
    const attacker = "https://attacker.example/client.json";
    const { flow } = await cimdFlow({
      [victim]: json({
        client_id: victim,
        client_name: "Victim",
        redirect_uris: ["https://victim.example/cb"],
      }),
      [attacker]: json({
        client_id: victim,
        client_name: "Attacker",
        redirect_uris: ["https://attacker.example/cb"],
      }),
    });
    expect((await authorizeAs(flow, victim, "https://victim.example/cb")).status).toBe(303);
    await expectRefusedLocally(await authorizeAs(flow, attacker, "https://attacker.example/cb"));
    expect(cacheRows(flow).map((r) => r.client_id)).toEqual([victim]);
    const stored = rows<{ document_json: string }>(flow, "SELECT document_json FROM cimd_cache");
    expect(stored[0]?.document_json).toContain("Victim");
    // And the attacker cannot reach the victim's redirect through the victim's id.
    await expectRefusedLocally(await authorizeAs(flow, victim, "https://attacker.example/cb"));
  });

  it("a cache row whose document names another client is ignored and refetched", async () => {
    const { flow, fetched } = await cimdFlow({ [id]: json(doc) });
    await authorizeAs(flow, id, redirect);
    flow.db.prepare("UPDATE cimd_cache SET document_json = ? WHERE client_id = ?").run(
      JSON.stringify({
        clientId: "https://other.example/x",
        name: "Planted",
        redirectUris: ["https://evil.example/cb"],
      }),
      id,
    );
    await expectRefusedLocally(await authorizeAs(flow, id, "https://evil.example/cb"));
    expect(fetched).toEqual([id, id]);
  });

  it("is bounded in size: past the cap the oldest rows go", async () => {
    const pages: Record<string, Page> = {};
    const ids = [1, 2, 3, 4].map((n) => `https://c${n}.example/client.json`);
    for (const [i, cid] of ids.entries()) {
      pages[cid] = json({ client_id: cid, redirect_uris: [`https://c${i + 1}.example/cb`] });
    }
    const { flow } = await cimdFlow(pages, { maxCacheRows: 2 });
    for (const [i, cid] of ids.entries()) {
      flow.clock.t += 1000;
      await authorizeAs(flow, cid, `https://c${i + 1}.example/cb`);
    }
    expect(
      cacheRows(flow)
        .map((r) => r.client_id)
        .sort(),
    ).toEqual([ids[2], ids[3]]);
  });

  it("concurrent authorizations of one client share a single fetch", async () => {
    const { flow, fetched } = await cimdFlow({ [id]: json(doc) });
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => authorizeAs(flow, id, redirect, new Jar())),
    );
    expect(results.map((r) => r.status)).toEqual([303, 303, 303, 303]);
    expect(fetched).toHaveLength(1);
  });

  it("consent pins the grant to the URL: a later document without the granted redirect ends remembered consent", async () => {
    let current: unknown = doc;
    const { flow } = await cimdFlow({ [id]: () => json(current) });
    const jar = new Jar();
    const issuedFirst = await obtainCode(flow, jar, challenge, {
      client_id: id,
      redirect_uri: redirect,
    });
    expect(issuedFirst.code).not.toBe("");
    // Remembered: a second request for the same scope skips the page.
    const again = await obtainCode(flow, jar, challenge, { client_id: id, redirect_uri: redirect });
    expect(again.code).not.toBe("");
    // The document moves on; once the cache lapses the old redirect is no longer the client's.
    current = { ...doc, redirect_uris: ["https://cache.example/new-cb"] };
    flow.clock.t += 6 * MIN;
    await expectRefusedLocally(await authorizeAs(flow, id, redirect, jar));
  });

  it("a fetch failure at the token endpoint is temporary, not invalid_client; a bad client is still refused", async () => {
    let up = true;
    const { flow } = await cimdFlow({
      [id]: () => (up ? json(doc) : { status: 503, body: "down" }),
    });
    const issued = await issue(flow, { client_id: id, redirect_uri: redirect });
    flow.clock.t += 10 * MIN;
    up = false;
    const down = await exchange(
      flow,
      refreshFields(issued.refresh, { client_id: id, resource: undefined }),
    );
    expect(down.res.status).toBe(503);
    expect(down.body.error).toBe("temporarily_unavailable");
    up = true;
    const back = await exchange(
      flow,
      refreshFields(issued.refresh, { client_id: id, resource: undefined }),
    );
    expect(back.res.status).toBe(200);
  });
});

// ---- review round 1 ----------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ATTACKER = { "x-test-ip": "198.51.100.7" };

describe("review round 1: remembered consent never auto-approves a loopback callback", () => {
  it("approved on port A, a request from port B (same client_id and path) is shown the consent page and gets no code", async () => {
    const { flow } = await cimdFlow({ [CLAUDE_CODE]: json(claudeCodeDoc) });
    const jar = new Jar();
    const first = await obtainCode(flow, jar, challenge, {
      client_id: CLAUDE_CODE,
      redirect_uri: "http://127.0.0.1:53124/callback",
    });
    expect(first.code).not.toBe("");
    const b = await authorizeAs(flow, CLAUDE_CODE, "http://127.0.0.1:53999/callback", jar);
    const page = await consentPage(flow, jar, handleOf(b.headers.get("location")));
    expect(page.seen.res.status).toBe(200);
    expect(page.seen.res.headers.get("location")).toBeNull();
    expect(page.seen.text).toContain("returns to an address on the computer");
    expect(rows(flow, "SELECT 1 FROM auth_codes")).toHaveLength(1);
  });

  it("the same port again asks too, for a static native client as well", async () => {
    const { flow } = await cimdFlow({});
    const jar = new Jar();
    const over = { client_id: LOOPBACK_CLIENT, redirect_uri: "http://127.0.0.1:4000/callback" };
    expect((await obtainCode(flow, jar, challenge, over)).code).not.toBe("");
    const again = await authorize(flow, jar, challenge, over);
    const page = await consentPage(flow, jar, handleOf(again.headers.get("location")));
    expect(page.seen.res.status).toBe(200);
    expect(rows(flow, "SELECT 1 FROM auth_codes")).toHaveLength(1);
  });
});

describe("review round 1: the localhost warning follows the SELECTED redirect, for any loopback host", () => {
  const LOOP = "returns to an address on the computer";
  const consentFor = async (doc: Record<string, unknown>, id: string, redirect: string) => {
    const { flow } = await cimdFlow({ [id]: json({ client_id: id, ...doc }) });
    const jar = new Jar();
    const a = await authorizeAs(flow, id, redirect, jar);
    const next = a.headers.get("location") ?? "";
    expect(next).toContain("/oauth/login");
    await loginFor(flow, jar, next);
    return (await consentPage(flow, jar, handleOf(next))).seen.text;
  };

  it.each([
    [
      "mixed document, loopback selected",
      ["https://evil.example/cb", "http://127.0.0.1/callback"],
      "http://127.0.0.1:5000/callback",
    ],
    ["http [::1]", ["https://o.example/cb", "http://[::1]/cb"], "http://[::1]:8080/cb"],
    ["https 127.0.0.2", ["https://127.0.0.2/cb"], "https://127.0.0.2/cb"],
    ["https [::1]", ["https://[::1]/cb"], "https://[::1]/cb"],
    ["https 127.0.0.1", ["https://127.0.0.1/cb"], "https://127.0.0.1/cb"],
  ])("warns: %s", async (name, uris, selected) => {
    const id = `https://warn-${name.replace(/\W+/g, "-")}.example/client.json`;
    expect(await consentFor({ redirect_uris: uris }, id, selected)).toContain(LOOP);
  });

  it("does not warn when the selected redirect is the hosted one of a mixed document", async () => {
    const id = "https://mixed-hosted.example/client.json";
    const text = await consentFor(
      { redirect_uris: ["https://mixed-hosted.example/cb", "http://127.0.0.1/callback"] },
      id,
      "https://mixed-hosted.example/cb",
    );
    expect(text).not.toContain(LOOP);
  });

  it("the never-approved warning is spec-literal: it ends at the first approval and does not return after a revoke", async () => {
    const { flow } = await cimdFlow({ [CHATGPT]: json(chatgptDoc) });
    const jar = new Jar();
    expect(
      (
        await obtainCode(flow, jar, challenge, {
          client_id: CHATGPT,
          redirect_uri: CHATGPT_REDIRECT,
        })
      ).code,
    ).not.toBe("");
    flow.db.prepare("UPDATE grants SET revoked_at = ?").run(Date.now());
    const a = await authorizeAs(flow, CHATGPT, CHATGPT_REDIRECT, jar);
    const page = await consentPage(flow, jar, handleOf(a.headers.get("location")));
    expect(page.seen.res.status).toBe(200);
    expect(page.seen.text).not.toContain("you have not approved it before");
  });
});

describe("review round 1: unauthenticated lookups are bounded", () => {
  const goodDoc = (id: string) => ({
    client_id: id,
    client_name: "Lookup",
    redirect_uris: ["https://lookup.example/cb"],
  });

  it("8 stalled name lookups release their slots at the deadline; a 9th client still resolves", async () => {
    const flow = await makeFlow({
      cimd: {
        timeoutMs: 150,
        resolveHost: (host) =>
          host.startsWith("stall") ? new Promise<string[]>(() => {}) : Promise.resolve([PUBLIC_IP]),
        fetch: (async (url: string | URL) =>
          new Response(JSON.stringify(goodDoc(String(url))), { status: 200 })) as typeof fetch,
      },
    });
    const stalled = Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        authorize(
          flow,
          new Jar(),
          challenge,
          {
            client_id: `https://stall${i}.example/c.json`,
            redirect_uri: "https://lookup.example/cb",
          },
          { "x-test-ip": `198.51.100.${10 + i}` },
        ),
      ),
    );
    const settled = await Promise.race([stalled, sleep(2000).then(() => "hung" as const)]);
    expect(settled).not.toBe("hung");
    const ninth = await authorize(
      flow,
      new Jar(),
      challenge,
      { client_id: "https://ok.example/c.json", redirect_uri: "https://lookup.example/cb" },
      { "x-test-ip": "198.51.100.99" },
    );
    expect(ninth.status).toBe(303);
  });

  it("a source past its budget of uncached lookups is refused without a fetch; another source and the cache are unaffected", async () => {
    const pages: Record<string, Page> = {};
    for (let i = 0; i <= CIMD_SOURCE_BURST; i++) {
      const id = `https://budget${i}.example/c.json`;
      pages[id] = json(goodDoc(id));
    }
    const { flow, fetched } = await cimdFlow(pages);
    const hit = (i: number, headers: Record<string, string>) =>
      authorize(
        flow,
        new Jar(),
        challenge,
        {
          client_id: `https://budget${i}.example/c.json`,
          redirect_uri: "https://lookup.example/cb",
        },
        headers,
      );
    for (let i = 0; i < CIMD_SOURCE_BURST; i++) expect((await hit(i, ATTACKER)).status).toBe(303);
    const before = fetched.length;
    const refused = await hit(CIMD_SOURCE_BURST, ATTACKER);
    expect(refused.status).toBe(400);
    expect(fetched).toHaveLength(before);
    // A cached client costs the attacker nothing and still works; another address is not blamed.
    expect((await hit(0, ATTACKER)).status).toBe(303);
    expect((await hit(CIMD_SOURCE_BURST, { "x-test-ip": "198.51.100.8" })).status).toBe(303);
    // The budget refills.
    flow.clock.t += MIN;
    expect((await hit(CIMD_SOURCE_BURST, ATTACKER)).status).toBe(303);
  });

  it("a request that is already malformed costs no outbound lookup (it is a local error)", async () => {
    const id = "https://cheap.example/c.json";
    const { flow, fetched, resolved } = await cimdFlow({ [id]: json(goodDoc(id)) });
    const redirect_uri = "https://lookup.example/cb";
    for (const over of [
      { response_type: "token" },
      { code_challenge: undefined },
      { code_challenge_method: "plain" },
      { redirect_uri: "not a url" },
      { redirect_uri: "https://lookup.example/cb#frag" },
    ]) {
      const res = await authorizeAs(flow, id, redirect_uri, new Jar(), over);
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    expect(fetched).toEqual([]);
    expect(resolved).toEqual([]);
    // Once the client is known, the same faults are error redirects again.
    expect((await authorizeAs(flow, id, redirect_uri)).status).toBe(303);
    const bad = await authorizeAs(flow, id, redirect_uri, new Jar(), { response_type: "token" });
    expect(bad.status).toBe(303);
    expect(bad.headers.get("location")).toContain("error=unsupported_response_type");
  });

  it("a failed fetch, a bad document and a refused host read the same on the authorize page", async () => {
    const down = "https://down.example/c.json";
    const junk = "https://junk.example/c.json";
    const other = "https://other.example/c.json";
    const { flow } = await cimdFlow({
      [down]: { status: 503, body: "down" },
      [junk]: { body: "not json" },
      [other]: json({
        client_id: "https://elsewhere.example/c.json",
        redirect_uris: ["https://lookup.example/cb"],
      }),
    });
    const texts: string[] = [];
    for (const id of [down, junk, other]) {
      const res = await authorizeAs(flow, id, "https://lookup.example/cb");
      expect(res.status).toBe(400);
      texts.push(await res.text());
    }
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).not.toMatch(/fetched|JSON|client_id/);
  });
});

describe("review round 1: consent POST re-checks the redirect", () => {
  it("a document that drops the redirect between the page and the approval issues no code", async () => {
    const id = "https://drop.example/client.json";
    const redirect = "https://drop.example/cb";
    const doc = { client_id: id, client_name: "Drop", redirect_uris: [redirect] };
    let current: unknown = doc;
    const { flow } = await cimdFlow({ [id]: () => json(current) });
    const jar = new Jar();
    const a = await authorizeAs(flow, id, redirect, jar);
    const next = a.headers.get("location") ?? "";
    await loginFor(flow, jar, next);
    const page = await consentPage(flow, jar, handleOf(next));
    expect(page.seen.res.status).toBe(200);
    current = { ...doc, redirect_uris: ["https://drop.example/elsewhere"] };
    flow.db.prepare("DELETE FROM cimd_cache").run();
    const done = await consentPost(flow, jar, {
      csrf: page.csrf,
      request: page.request,
      decision: "approve",
    });
    expect(done.res.status).toBe(400);
    expect(done.res.headers.get("location")).toBeNull();
    expect(rows(flow, "SELECT 1 FROM auth_codes")).toEqual([]);
  });
});

describe("review round 1: client_name cannot spoof with invisible or bidi characters", () => {
  const name = (client_name: string) => {
    const r = parseClientDocument(
      "https://n.example/c.json",
      JSON.stringify({
        client_id: "https://n.example/c.json",
        client_name,
        redirect_uris: ["https://n.example/cb"],
      }),
    );
    if (!r.ok) throw new Error(r.message);
    return r.doc.name;
  };

  it("removes bidi overrides and isolates and zero-width marks", () => {
    expect(name("Safe\u202Eevil.example\u202C App")).toBe("Safeevil.example App");
    expect(name("A\u2066B\u2067C\u2068D\u2069E")).toBe("ABCDE");
    expect(name("Z\u200BW\u200CJ\u200D\u2060\uFEFFok")).toBe("ZWJok");
  });
});
