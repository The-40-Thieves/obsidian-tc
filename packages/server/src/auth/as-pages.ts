// HTML for the bundled authorization server's own pages (design v2 section 4.3), and the headers
// every one of its responses carries. The Content-Security-Policy leaves nothing for injected markup
// to do: no script, no inline style, no framing, forms only to this origin. Hence the pages carry
// no inline `style=` or script and take their look from the one stylesheet served at `/oauth/as.css`.

export const AS_CSS_PATH = "/oauth/as.css";

export const AS_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export const AS_CSS = `body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f6f7;color:#1c1c1e}
main{max-width:26rem;margin:10vh auto;padding:2rem;background:#fff;border-radius:.5rem;box-shadow:0 1px 4px #0002}
h1{font-size:1.25rem;margin:0 0 1rem}
label{display:block;margin:.75rem 0 .25rem;font-weight:600}
input{box-sizing:border-box;width:100%;padding:.5rem;font:inherit}
button{margin-top:1.25rem;padding:.5rem 1rem;font:inherit}
.error{color:#a40000;margin:.5rem 0}
.note{color:#555;font-size:.9rem}
`;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${AS_CSS_PATH}">
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${body}
</main>
</body>
</html>
`;
}

const error = (msg: string | undefined): string =>
  msg === undefined ? "" : `<p class="error" role="alert">${escapeHtml(msg)}</p>\n`;

const hidden = (csrf: string): string =>
  `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;

export const messagePage = (title: string, message: string): string =>
  layout(title, `<p>${escapeHtml(message)}</p>`);

export function loginPage(o: {
  csrf: string;
  username?: string;
  error?: string;
  /** The pending authorization request this sign-in continues, if any. */
  request?: string | undefined;
  /** A fresh sign-in is required before the client may be approved. */
  reauth?: boolean | undefined;
}): string {
  const carry =
    o.request === undefined
      ? ""
      : `<input type="hidden" name="request" value="${escapeHtml(o.request)}">\n`;
  const why = o.reauth
    ? '<p class="note">Sign in again to approve a new application: this is the first time it asks for access.</p>\n'
    : "";
  return layout(
    "Sign in",
    `${error(o.error)}${why}<form method="post" action="/oauth/login">
${hidden(o.csrf)}
${carry}<label for="username">Username</label>
<input id="username" name="username" value="${escapeHtml(o.username ?? "")}" autocomplete="username" maxlength="64" required>
<label for="password">Password</label>
<input id="password" type="password" name="password" autocomplete="current-password" maxlength="1024" required>
<button type="submit">Sign in</button>
</form>`,
  );
}

export function setupPage(o: { csrf: string; username?: string; error?: string }): string {
  return layout(
    "Claim this server",
    `${error(o.error)}<p class="note">Choose the operator account for this server. You need the one-time setup token set on the host.</p>
<form method="post" action="/oauth/setup">
${hidden(o.csrf)}
<label for="token">Setup token</label>
<input id="token" type="password" name="token" autocomplete="off" required>
<label for="username">Username</label>
<input id="username" name="username" value="${escapeHtml(o.username ?? "operator")}" autocomplete="username" maxlength="64" required>
<label for="password">Password (at least 12 characters)</label>
<input id="password" type="password" name="password" autocomplete="new-password" maxlength="1024" required>
<label for="confirm">Repeat the password</label>
<input id="confirm" type="password" name="confirm" autocomplete="new-password" maxlength="1024" required>
<button type="submit">Claim</button>
</form>`,
  );
}

export function signedInPage(o: { username: string; csrf: string }): string {
  return layout(
    "Signed in",
    `<p>Signed in as <strong>${escapeHtml(o.username)}</strong>.</p>
<form method="post" action="/oauth/logout">
${hidden(o.csrf)}
<button type="submit">Sign out</button>
</form>`,
  );
}

export interface ConsentView {
  csrf: string;
  /** The pending request's handle, carried through the form. */
  request: string;
  clientName: string;
  clientId: string;
  /** Where the browser goes after a choice, as a host (or scheme) the operator can recognise. */
  redirectHost: string;
  /** Every redirect the client is registered with is on this machine: any local program can claim it. */
  loopbackOnly: boolean;
  scopes: Array<{ scope: string; words: string }>;
  resource: string;
  /** Configured personas and their vaults; absent when none are configured. */
  personas?: Array<{ name: string; vaults: string[] }>;
}

export function consentPage(o: ConsentView): string {
  const scopes = o.scopes
    .map((s) => `<li>${escapeHtml(s.words)} <code>${escapeHtml(s.scope)}</code></li>`)
    .join("\n");
  const warn = o.loopbackOnly
    ? '<p class="error" role="alert">This application returns to an address on the computer that is signing in. Any program running there could be pretending to be it. Approve only if you started this sign-in yourself.</p>\n'
    : "";
  const option = (v: string, label = v): string =>
    `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`;
  const picker =
    o.personas === undefined || o.personas.length === 0
      ? ""
      : `<label for="persona">Persona</label>
<select id="persona" name="persona">
${option("", "No persona: the scopes above")}
${o.personas.map((p) => option(p.name)).join("\n")}
</select>
<label for="vault">Vault (with a persona)</label>
<select id="vault" name="vault">
${option("", "The persona's first vault")}
${[...new Set(o.personas.flatMap((p) => p.vaults))].map((v) => option(v)).join("\n")}
</select>
<p class="note">A persona can only narrow what is approved here, never widen it.</p>
`;
  return layout(
    "Approve access",
    `${warn}<p><strong>${escapeHtml(o.clientName)}</strong> (<code>${escapeHtml(o.clientId)}</code>) asks to use this server on your behalf. After you choose, your browser returns to <code>${escapeHtml(o.redirectHost)}</code>.</p>
<p>It will be able to:</p>
<ul>
${scopes}
</ul>
<p class="note">Resource: <code>${escapeHtml(o.resource)}</code></p>
<form method="post" action="/oauth/consent">
${hidden(o.csrf)}
<input type="hidden" name="request" value="${escapeHtml(o.request)}">
${picker}<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`,
  );
}
