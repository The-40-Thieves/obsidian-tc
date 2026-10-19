// Sign-in and vault calls for index.html. Tokens live in `session`, in memory only. sessionStorage
// holds just the client_id (per server origin) and the pending sign-in (PKCE verifier, state),
// because the authorization server navigates the whole page away and back.
import {
  Client,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  StreamableHTTPClientTransport,
} from "https://esm.sh/@modelcontextprotocol/client@2.3.1";
import {
  buildAuthorizeUrl,
  CallbackError,
  checkCallback,
  randomToken,
  s256Challenge,
} from "./oauth.mjs";

const PENDING_KEY = "obsidian-tc-web-client:pending";
const CLIENT_KEY = (origin) => `obsidian-tc-web-client:client:${origin}`;
const REFRESH_MARGIN_MS = 30_000;

let session = null; // { mcpUrl, resource, issuer, metadata, clientInformation, tokens, expiresAt }
let client = null;
let refreshing = null;
let viaFacade = false;

const $ = (id) => document.getElementById(id);
const pageUrl = () => location.origin + location.pathname;
const expiryOf = (tokens) =>
  tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : Number.POSITIVE_INFINITY;

function status(message) {
  $("status").textContent = message;
}

async function signIn(mcpUrl) {
  const protectedResource = await discoverOAuthProtectedResourceMetadata(mcpUrl);
  const issuer = protectedResource.authorization_servers?.[0];
  if (!issuer)
    throw new Error("the server's protected-resource metadata names no authorization server");
  const metadata = await discoverAuthorizationServerMetadata(issuer);
  if (!metadata) throw new Error(`no authorization-server metadata at ${issuer}`);
  const redirectUri = pageUrl();
  const clientInformation = await clientFor(mcpUrl, metadata, redirectUri);
  const verifier = randomToken();
  const state = randomToken();
  const resource = protectedResource.resource ?? mcpUrl;
  sessionStorage.setItem(
    PENDING_KEY,
    JSON.stringify({
      mcpUrl,
      resource,
      issuer: metadata.issuer,
      issParameterSupported: metadata.authorization_response_iss_parameter_supported === true,
      clientId: clientInformation.client_id,
      redirectUri,
      verifier,
      state,
    }),
  );
  location.assign(
    buildAuthorizeUrl({
      authorizationEndpoint: metadata.authorization_endpoint,
      clientId: clientInformation.client_id,
      redirectUri,
      state,
      codeChallenge: await s256Challenge(verifier),
      resource,
    }),
  );
}

async function clientFor(mcpUrl, metadata, redirectUri) {
  const key = CLIENT_KEY(new URL(mcpUrl).origin);
  const cached = JSON.parse(sessionStorage.getItem(key) ?? "null");
  if (cached?.issuer === metadata.issuer && cached.redirectUri === redirectUri) {
    return { client_id: cached.clientId };
  }
  const registered = await registerClient(metadata.issuer, {
    metadata,
    clientMetadata: {
      client_name: "obsidian-tc examples/web-client",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });
  sessionStorage.setItem(
    key,
    JSON.stringify({ issuer: metadata.issuer, redirectUri, clientId: registered.client_id }),
  );
  return { client_id: registered.client_id };
}

/** Completes a sign-in when this load is the redirect back. Returns false on a plain load. */
async function finishSignIn() {
  const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null");
  const params = new URLSearchParams(location.search);
  if (pending === null || (!params.has("state") && !params.has("code") && !params.has("error"))) {
    return false;
  }
  sessionStorage.removeItem(PENDING_KEY);
  history.replaceState(null, "", location.pathname);
  const code = checkCallback(params, {
    state: pending.state,
    issuer: pending.issuer,
    issParameterSupported: pending.issParameterSupported,
  });
  const metadata = await discoverAuthorizationServerMetadata(pending.issuer);
  const tokens = await exchangeAuthorization(pending.issuer, {
    metadata,
    clientInformation: { client_id: pending.clientId },
    authorizationCode: code,
    iss: params.get("iss") ?? undefined,
    codeVerifier: pending.verifier,
    redirectUri: pending.redirectUri,
    resource: pending.resource,
  });
  session = {
    mcpUrl: pending.mcpUrl,
    resource: pending.resource,
    issuer: pending.issuer,
    metadata,
    clientInformation: { client_id: pending.clientId },
    tokens,
    expiresAt: expiryOf(tokens),
  };
  return true;
}

async function refresh() {
  const tokens = await refreshAuthorization(session.issuer, {
    metadata: session.metadata,
    clientInformation: session.clientInformation,
    refreshToken: session.tokens.refresh_token,
    resource: session.resource,
  });
  session.tokens = {
    ...tokens,
    refresh_token: tokens.refresh_token ?? session.tokens.refresh_token,
  };
  session.expiresAt = expiryOf(tokens);
}

/** One refresh at a time: concurrent tool calls share the same round trip. */
function refreshOnce() {
  refreshing ??= refresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Answers a server-initiated elicitation: the form is a JSON box, Accept sends its content. */
function askUser(params) {
  return new Promise((resolve) => {
    const panel = $("hitl");
    $("hitl-message").textContent = params.message;
    $("hitl-schema").textContent = JSON.stringify(params.requestedSchema ?? {}, null, 2);
    $("hitl-content").value = "{}";
    panel.hidden = false;
    const finish = (answer) => {
      panel.hidden = true;
      $("hitl-accept").onclick = null;
      $("hitl-decline").onclick = null;
      resolve(answer);
    };
    $("hitl-accept").onclick = () => {
      try {
        const content = JSON.parse($("hitl-content").value);
        finish({ action: "accept", content });
      } catch (err) {
        status(`the answer is not valid JSON: ${err.message}`);
      }
    };
    $("hitl-decline").onclick = () => finish({ action: "decline" });
  });
}

async function connect(mcpUrl) {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    authProvider: {
      token: async () => {
        if (Date.now() >= session.expiresAt - REFRESH_MARGIN_MS) await refreshOnce();
        return session.tokens.access_token;
      },
      onUnauthorized: async () => {
        await refreshOnce();
      },
    },
  });
  const next = new Client({ name: "obsidian-tc-examples-web-client", version: "0.1.0" });
  next.setRequestHandler("elicitation/create", (request) => askUser(request.params));
  await next.connect(transport);
  const { tools } = await next.listTools();
  viaFacade = tools.some((tool) => tool.name === "call_capability");
  client = next;
}

/** Calls a vault tool through the facade when the server advertises it, else directly. */
async function callVault(name, args) {
  const result = viaFacade
    ? await client.callTool({ name: "call_capability", arguments: { name, args } })
    : await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(textOf(result));
  if (result.resultType === "input_required") {
    // Modern-era input requests are shown as JSON only; answering them is not wired (see README).
    throw new Error(
      `the server asked for input this page does not answer: ${JSON.stringify(result)}`,
    );
  }
  return result.structuredContent ?? JSON.parse(textOf(result));
}

function textOf(result) {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function loadVaults() {
  const { vaults } = await callVault("list_vaults", {});
  const select = $("vault");
  select.replaceChildren(...vaults.map((vault) => new Option(vault.name, vault.id)));
  $("search-form").hidden = false;
  status(`signed in; ${vaults.length} vault(s)`);
}

async function search(query) {
  const { items = [] } = await callVault("search_text", { vault: $("vault").value, query });
  const list = $("results");
  list.replaceChildren(
    ...items.map((hit) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = hit.path;
      button.addEventListener("click", () => run(() => readNote(hit.path)));
      item.append(button);
      return item;
    }),
  );
  status(`${items.length} result(s)`);
}

async function readNote(path) {
  const note = await callVault("read_note", { vault: $("vault").value, path });
  $("note-path").textContent = note.path;
  $("note-body").textContent = note.body ?? note.content ?? "";
}

async function run(action) {
  try {
    await action();
  } catch (err) {
    status(err instanceof CallbackError ? `sign-in refused: ${err.message}` : err.message);
  }
}

$("signin").addEventListener("click", () => run(() => signIn($("mcp-url").value)));
$("search").addEventListener("submit", (event) => {
  event.preventDefault();
  run(() => search($("query").value));
});

run(async () => {
  if (await finishSignIn()) {
    await connect(session.mcpUrl);
    await loadVaults();
  }
});
