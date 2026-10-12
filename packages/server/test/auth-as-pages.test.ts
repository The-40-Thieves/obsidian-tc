import { describe, expect, it } from "vitest";
import {
  AS_RESPONSE_HEADERS,
  accountPage,
  consentPage,
  loginPage,
  setupPage,
  signedInPage,
} from "../src/auth/as-pages";

const BROWSER_INCIDENT = `Request refused
This request could not be verified. Reload the page and try again.`;

describe("authorization-server form referrer policy", () => {
  it("keeps a real Origin on every same-origin form POST", () => {
    const pages = [
      ["login", loginPage({ csrf: "login-csrf" })],
      ["setup", setupPage({ csrf: "setup-csrf" })],
      ["signed in", signedInPage({ username: "operator", csrf: "logout-csrf" })],
      [
        "account",
        accountPage({
          username: "operator",
          registerCsrf: "register-csrf",
          removeCsrf: "remove-csrf",
          logoutCsrf: "logout-csrf",
          fresh: true,
          credentials: [
            {
              id: "credential-id",
              deviceType: "singleDevice",
              backedUp: false,
              createdAt: 0,
              lastUsedAt: null,
            },
          ],
        }),
      ],
      [
        "consent",
        consentPage({
          csrf: "consent-csrf",
          request: "request-handle",
          clientName: "Test client",
          clientId: "test-client",
          redirectHost: "client.example",
          loopbackOnly: false,
          scopes: [{ scope: "read:notes", words: "Read notes" }],
          resource: "https://server.example/mcp",
        }),
      ],
    ] as const;

    const headerPolicy = AS_RESPONSE_HEADERS["referrer-policy"];
    expect(headerPolicy, BROWSER_INCIDENT).not.toBe("no-referrer");

    for (const [name, html] of pages) {
      expect(html, name).toMatch(/<form method="post"/);
      const metaPolicy = html.match(/<meta name="referrer" content="([^"]+)">/i)?.[1];
      if (metaPolicy !== undefined) {
        expect(metaPolicy, `${name}: ${BROWSER_INCIDENT}`).not.toBe("no-referrer");
      }
    }
  });
});
