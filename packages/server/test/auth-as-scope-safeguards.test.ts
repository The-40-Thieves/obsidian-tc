import { afterEach, describe, expect, it } from "vitest";
import { everApproved } from "../src/auth/as-grants";
import {
  authorize,
  cleanupFlows,
  consentPage,
  consentPost,
  handleOf,
  Jar,
  LOOPBACK_CLIENT,
  makeFlow,
  obtainCode,
  pkce,
  rows,
} from "./as-flow-harness";

afterEach(cleanupFlows);

describe("scope consent safeguards", () => {
  it.each([undefined, "", "offline_access"])(
    "defaulted scope %s always asks in full despite a covering remembered grant",
    async (scope) => {
      const flow = await makeFlow({ as: { consent: { remembered: "silent" } } });
      const jar = new Jar();
      const { challenge } = pkce();
      const client = { client_id: LOOPBACK_CLIENT, redirect_uri: "http://localhost:5001/cb" };
      expect(
        (await obtainCode(flow, jar, challenge, { ...client, scope: "read:*" })).code,
      ).not.toBe("");
      const before = rows(flow, "SELECT 1 FROM auth_codes").length;
      const a = await authorize(flow, jar, challenge, { ...client, scope });
      const handle = handleOf(a.headers.get("location"));
      const page = await consentPage(flow, jar, handle);
      expect(page.seen.res.status).toBe(200);
      expect(page.seen.text).toContain("Approve access");
      expect(page.seen.text).toContain("did not request explicit permissions");
      expect(page.seen.text).not.toContain('name="remembered"');
      expect(rows(flow, "SELECT 1 FROM auth_codes")).toHaveLength(before);
      const forged = await consentPost(flow, jar, {
        csrf: page.csrf,
        request: handle,
        decision: "approve",
        remembered: "1",
      });
      expect(forged.res.headers.get("location")).toBe(`/oauth/consent?request=${handle}`);
      expect(rows(flow, "SELECT 1 FROM auth_codes")).toHaveLength(before);
      const done = await consentPost(flow, jar, {
        csrf: page.csrf,
        request: handle,
        decision: "approve",
      });
      expect(done.res.headers.get("location")).toContain("code=");
    },
  );

  it("uses the configured vocabulary as the default but still asks on every request", async () => {
    const flow = await makeFlow({ scopesSupported: ["read:notes", "write:notes"] });
    const jar = new Jar();
    const { challenge } = pkce();
    await obtainCode(flow, jar, challenge, { scope: "read:notes write:notes" });
    const a = await authorize(flow, jar, challenge, { scope: undefined });
    const page = await consentPage(flow, jar, handleOf(a.headers.get("location")));
    expect(page.seen.text).toContain("Approve access");
    expect(page.seen.text).toContain("<code>write:notes</code>");
    expect(page.seen.text).toContain("did not request explicit permissions");
  });

  it("shows dropped scopes, escaped, even when remembered consent covers the remaining scopes", async () => {
    const flow = await makeFlow({ as: { consent: { remembered: "silent" } } });
    const jar = new Jar();
    const { challenge } = pkce();
    await obtainCode(flow, jar, challenge);
    const a = await authorize(flow, jar, challenge, { scope: "read:notes <script>" });
    const page = await consentPage(flow, jar, handleOf(a.headers.get("location")));
    expect(page.seen.res.status).toBe(200);
    expect(page.seen.text).toContain("Unsupported permissions were dropped");
    expect(page.seen.text).toContain("&lt;script&gt;");
    expect(page.seen.text).not.toContain("<script>");
    expect(page.seen.text).toContain("Approve access");
    const done = await consentPost(flow, jar, {
      csrf: page.csrf,
      request: page.request,
      decision: "approve",
    });
    expect(done.res.headers.get("location")).toContain("code=");
    expect(rows<{ request_scope: string }>(flow, "SELECT request_scope FROM auth_codes")).toEqual([
      { request_scope: "read:notes" },
      { request_scope: "read:notes" },
    ]);
  });

  it("revoked grants no longer suppress the unapproved-client warning", async () => {
    const flow = await makeFlow();
    await obtainCode(flow, new Jar(), pkce().challenge);
    expect(everApproved(flow.db, "test-client")).toBe(true);
    flow.db.prepare("UPDATE grants SET revoked_at = ?").run(flow.clock.t);
    expect(everApproved(flow.db, "test-client")).toBe(false);
  });
});
