// `GET /oauth/authorize` and `GET/POST /oauth/consent` of the bundled authorization server (design v2
// section 4.3). Authorize validates the request (as-request.ts), parks it as a pending request and
// sends the browser to sign in or to consent. Consent shows the operator exactly what is asked and,
// on approval, creates the grant and a 60 s single-use code and redirects to the client. Every
// redirect to a client, errors included, carries `iss` (RFC 9207) and the client's `state`; every
// answer to a form POST is a 303, so a browser never re-sends credentials to the redirect target.
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Context, Hono } from "hono";
import { accountBounds, applyBounds, narrowScopes } from "./as-account";
import { clientResolverFor } from "./as-client-resolver";
import {
  type AsClient,
  describeScope,
  isLoopbackRedirect,
  isLoopbackUri,
  redirectKey,
  redirectUriAllowed,
  scopesCovered,
} from "./as-clients";
import {
  approveRequest,
  createPending,
  discardPending,
  everApproved,
  FRESH_LOGIN_MS,
  type Grant,
  type GrantKey,
  liveGrants,
  loadPending,
  type PendingRequest,
} from "./as-grants";
import { type AsRouteDeps, enabledAs } from "./as-metadata";
import { socketClientIp } from "./as-operator";
import type { SessionInfo } from "./as-operator-store";
import { consentPage, messagePage } from "./as-pages";
import { parseAuthorizeRequest } from "./as-request";
import { createAsBrowser, requestHandleOf } from "./as-session";
import { resolvePersona } from "./persona";

type AuthConfig = ServerConfig["auth"];

const defaultLog = (line: string): void => {
  process.stderr.write(`[as] ${line}\n`);
};

/** The `form-action` source that lets the browser follow the consent POST's redirect to the client. */
function formActionSource(redirectUri: string): string | undefined {
  try {
    const u = new URL(redirectUri);
    if (u.protocol !== "http:" && u.protocol !== "https:") return u.protocol;
    return isLoopbackUri(redirectUri) ? `http://${u.hostname}:*` : u.origin;
  } catch {
    return undefined;
  }
}

function redirectHost(redirectUri: string): string {
  try {
    const u = new URL(redirectUri);
    if (u.protocol === "http:" || u.protocol === "https:") return u.hostname;
    return `${u.protocol}//${u.host}`;
  } catch {
    return redirectUri;
  }
}

/** Did the bounds leave every requested scope (and the vault) as asked? */
const withinBounds = (r: ReturnType<typeof applyBounds>, asked: readonly string[]): boolean =>
  r.ok && r.scopes.length === asked.length;

export function mountAuthorizeRoutes(app: Hono, auth: AuthConfig, deps?: AsRouteDeps): void {
  const as = enabledAs(auth);
  if (as === undefined || deps === undefined) return;
  const b = createAsBrowser({
    auth,
    db: deps.db,
    secret: deps.secret,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const { db, now, html } = b;
  const log = deps.log ?? defaultLog;
  const resource = auth.resource as string;
  const clientIp = deps.clientIp ?? socketClientIp;
  const resolveClient = clientResolverFor(deps, as);

  const localError = (c: Context, message: string) =>
    html(c, 400, messagePage("Cannot continue", message));
  const expired = (c: Context) =>
    localError(
      c,
      "This sign-in request has expired or was already used. Start again from the application.",
    );

  /** A redirect to the client: the parameters, then `iss`, which nothing in the URI can override. */
  const toClient = (
    c: Context,
    redirectUri: string,
    params: Record<string, string | undefined>,
  ) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    u.searchParams.set("iss", as.issuer);
    return c.redirect(u.toString(), 303);
  };
  const deniedTo = (c: Context, p: PendingRequest, error: string, description: string) =>
    toClient(c, p.redirectUri, {
      error,
      error_description: description,
      state: p.state ?? undefined,
    });

  /** The pending request's client as it is NOW, or undefined when it is gone or no longer lists the
   *  redirect: a metadata document can move on between the page and the approval (so POST asks too). */
  const clientNow = async (c: Context, p: PendingRequest): Promise<AsClient | undefined> => {
    const found = await resolveClient(p.clientId, { source: clientIp(c) });
    return "client" in found && redirectUriAllowed(found.client.redirectUris, p.redirectUri)
      ? found.client
      : undefined;
  };
  const NO_LONGER_REGISTERED = "This client is no longer registered.";

  const keyOf = (p: PendingRequest, session: SessionInfo): GrantKey => ({
    sub: session.sub,
    clientId: p.clientId,
    redirectKey: redirectKey(p.redirectUri),
    resource: p.resource,
  });

  // ---- authorize -----------------------------------------------------------------------------

  app.get("/oauth/authorize", async (c) => {
    const outcome = await parseAuthorizeRequest(new URL(c.req.url).searchParams, {
      resolveClient,
      resource,
      scopesSupported: auth.scopesSupported,
      source: clientIp(c),
    });
    if (outcome.kind === "local") return localError(c, outcome.message);
    if (outcome.kind === "redirect") {
      return toClient(c, outcome.redirectUri, {
        error: outcome.error,
        error_description: outcome.description,
        state: outcome.state,
      });
    }
    const handle = createPending(db, outcome.request, now(), clientIp(c));
    if (handle === undefined) {
      c.header("retry-after", "60");
      return html(c, 503, messagePage("Busy", "Too many sign-ins are waiting. Try again shortly."));
    }
    const next = b.sessionOf(c) !== undefined ? "consent" : "login";
    return c.redirect(`/oauth/${next}?request=${handle}`, 303);
  });

  // ---- consent -------------------------------------------------------------------------------

  /** What consent must do for this request and session. */
  type Step =
    | { kind: "remembered"; grant: Grant }
    | { kind: "reauth" }
    | { kind: "ask"; first: boolean };
  const stepFor = (p: PendingRequest, session: SessionInfo): Step => {
    const grants = liveGrants(db, keyOf(p, session));
    // `auth.as.consent.loopback: prompt` stops a loopback callback being remembered: its port is
    // picked at run time and nothing proves WHICH local process is behind it, so a grant made for one
    // process would also approve another that claims the same client_id and path (design v2 section
    // 4.3 gives no instance proof). The default, `remember`, accepts that so a native CLI signs in
    // without a click. Without a remembered grant, `first` still keys on whether the client has any.
    const remembers = as.consent.loopback === "remember" || !isLoopbackRedirect(p.redirectUri);
    // A remembered grant is reused only while the account's CURRENT bounds still allow all of it:
    // narrowing the account after the grant makes the operator decide again.
    const bounds = accountBounds(db, session.sub);
    const grant = grants.find(
      (g) =>
        remembers &&
        scopesCovered(g.scopes, p.scopes) &&
        bounds !== undefined &&
        withinBounds(applyBounds(bounds, { scopes: p.scopes, vault: g.vault }), p.scopes),
    );
    if (grant !== undefined) return { kind: "remembered", grant };
    // The first grant to a client needs a password typed just now; widening a remembered one does not.
    const first = grants.length === 0;
    return first && now() - session.createdAt > FRESH_LOGIN_MS
      ? { kind: "reauth" }
      : { kind: "ask", first };
  };

  const issue = (
    c: Context,
    handle: string,
    p: PendingRequest,
    session: SessionInfo,
    grant: { scopes: string[]; persona: string | null; vault: string | null; reuse?: Grant },
  ) => {
    const approved = approveRequest(db, {
      handle,
      key: keyOf(p, session),
      scopes: grant.scopes,
      persona: grant.persona,
      vault: grant.vault,
      now: now(),
      ...(grant.reuse ? { reuse: grant.reuse } : {}),
    });
    if (approved === undefined) return expired(c);
    log(`consent approved client=${p.clientId}`);
    return toClient(c, p.redirectUri, { code: approved.code, state: p.state ?? undefined });
  };

  const loginFor = (handle: string, reauth: boolean) =>
    `/oauth/login?request=${handle}${reauth ? "&reauth=1" : ""}`;

  app.get("/oauth/consent", async (c) => {
    if (!b.claimed()) return b.notClaimed(c);
    const handle = requestHandleOf(c.req.query("request"));
    const pending = handle === undefined ? undefined : loadPending(db, handle, now());
    if (handle === undefined || pending === undefined) return expired(c);
    // Resolved again, not trusted from authorize: a metadata document can have moved on since, and
    // a redirect it no longer lists must not be approved.
    const client = await clientNow(c, pending);
    if (client === undefined) return localError(c, NO_LONGER_REGISTERED);
    const session = b.sessionOf(c);
    if (session === undefined) return c.redirect(loginFor(handle, false), 303);
    const step = stepFor(pending, session);
    if (step.kind === "reauth") return c.redirect(loginFor(handle, true), 303);
    if (step.kind === "remembered") {
      return issue(c, handle, pending, session, {
        scopes: pending.scopes,
        persona: step.grant.persona,
        vault: step.grant.vault,
        reuse: step.grant,
      });
    }
    // Offer only what the account can still grant (POST re-applies the bounds either way).
    const bounds = accountBounds(db, session.sub);
    const offered = bounds === undefined ? [] : narrowScopes(bounds, pending.scopes);
    const shown = offered.length > 0 ? offered : pending.scopes;
    const personas = Object.entries(deps.personas ?? {}).map(([name, p]) => ({
      name,
      vaults: p.vaults,
    }));
    // The browser must be allowed to follow the POST's redirect to the client (CSP form-action
    // covers redirects), so this page's policy names that one destination beyond 'self'.
    const dest = formActionSource(pending.redirectUri);
    if (dest !== undefined) {
      c.header(
        "content-security-policy",
        `default-src 'none'; style-src 'self'; form-action 'self' ${dest}; frame-ancestors 'none'`,
      );
    }
    return html(
      c,
      200,
      consentPage({
        csrf: b.formToken(c, `consent:${handle}`, session),
        request: handle,
        clientName: client.name,
        clientId: client.clientId,
        redirectHost: redirectHost(pending.redirectUri),
        loopbackOnly: isLoopbackRedirect(pending.redirectUri),
        ...(client.cimd
          ? {
              clientHost: new URL(client.clientId).hostname,
              unapproved: !everApproved(db, client.clientId),
            }
          : {}),
        ...(client.dcr ? { selfRegistered: !everApproved(db, client.clientId) } : {}),
        scopes: shown.map((scope) => ({ scope, words: describeScope(scope) })),
        resource: pending.resource,
        ...(personas.length > 0 ? { personas } : {}),
      }),
    );
  });

  app.post("/oauth/consent", async (c) => {
    if (!b.claimed()) return b.notClaimed(c);
    const form = await b.readForm(c);
    if (form instanceof Response) return form;
    const handle = requestHandleOf(form.get("request") ?? undefined);
    if (handle === undefined) return b.forbidden(c);
    const session = b.sessionOf(c);
    if (session === undefined) return c.redirect(loginFor(handle, false), 303);
    // Bound to this session AND this request: another request's token, or none, approves nothing.
    if (!b.tokenValid(c, `consent:${handle}`, form.get("csrf") ?? "", session)) {
      return b.forbidden(c);
    }
    const pending = loadPending(db, handle, now());
    if (pending === undefined) return expired(c);
    // The same check as the page: a document that dropped the redirect since must not get a code.
    if ((await clientNow(c, pending)) === undefined) return localError(c, NO_LONGER_REGISTERED);
    if (stepFor(pending, session).kind === "reauth") {
      return c.redirect(loginFor(handle, true), 303);
    }

    if (form.get("decision") !== "approve") {
      discardPending(db, handle, now());
      log(`consent denied client=${pending.clientId}`);
      return deniedTo(c, pending, "access_denied", "the operator denied the request");
    }

    const persona = form.get("persona") || null;
    const chosenVault = form.get("vault") || null;
    let vault: string | null = null;
    if (persona !== null) {
      const r = resolvePersona(persona, chosenVault ?? undefined, deps.personas);
      if (!r.ok) return localError(c, "That persona and vault do not go together.");
      vault = r.resolution.vaultId;
    } else if (chosenVault !== null) {
      return localError(c, "Choose a persona to bind a vault.");
    }
    // The account's own upper bounds (users.scopes_allowed / vaults_allowed) only ever remove.
    const bounds = accountBounds(db, session.sub);
    if (bounds === undefined) return localError(c, "This account is not available.");
    const bounded = applyBounds(bounds, { scopes: pending.scopes, vault });
    if (!bounded.ok && bounded.reason === "vault") {
      return localError(
        c,
        vault === null
          ? "This account is limited to specific vaults. Choose a persona that names one."
          : "This account may not use that vault.",
      );
    }
    if (!bounded.ok) {
      discardPending(db, handle, now());
      return deniedTo(c, pending, "access_denied", "this account may not grant those scopes");
    }
    // `bounded.vault` is the concrete vault: a vault-bounded account never gets an unbound grant.
    return issue(c, handle, pending, session, {
      scopes: bounded.scopes,
      persona,
      vault: bounded.vault,
    });
  });
}
