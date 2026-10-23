// Domain 13 — Templater. list_templates is a plain read-side bridge call;
// execute_template carries write:templater, a HITL floor, so dispatch ALWAYS
// demands an elicit token before the handler runs (no silent template execution).
import { afterEach, describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { withWikiLogScope } from "../src/tools/m7/knowledge/wiki-log-acl";
import { type M4Vault, makeM4Vault } from "./m4-helpers";

describe("list_templates", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("lists templates via the bridge (no confirmation needed)", async () => {
    v = makeM4Vault({
      installed: ["templater"],
      routes: {
        "POST /obsidian-tc/v1/templater/list": {
          body: { ok: true, result: { items: [{ path: "Templates/daily.md", name: "daily" }] } },
        },
      },
    });
    const res = await v.call("list_templates", { vault: "test" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(((res.data as Record<string, unknown>).items as unknown[]).length).toBe(1);
  });

  it("degrades to plugin_missing when Templater is absent", async () => {
    v = makeM4Vault({ installed: [] });
    const res = await v.call("list_templates", { vault: "test" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_missing");
  });

  it("does not pass through a path-bearing envelope without items", async () => {
    v = makeM4Vault({
      installed: ["templater"],
      routes: {
        "POST /obsidian-tc/v1/templater/list": {
          body: {
            ok: true,
            result: { templates: [{ path: ".trash/secret.md", parsed_body: "TOPSECRET" }] },
          },
        },
      },
    });
    const res = await v.call("list_templates", { vault: "test" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ vault: "test", items: [], total: 0 });
  });

  it.each([null, "invalid"])(
    "reports plugin_incompatible when the companion returns a non-object result (%#)",
    async (result) => {
      v = makeM4Vault({
        installed: ["templater"],
        routes: {
          "POST /obsidian-tc/v1/templater/list": {
            body: { ok: true, result },
          },
        },
      });
      const res = await v.call("list_templates", { vault: "test" });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("plugin_incompatible");
    },
  );
});

describe("execute_template", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  const input = { vault: "test", template: "Templates/daily.md", target: "Daily/2026-06-18.md" };
  const routes = {
    "POST /obsidian-tc/v1/templater/execute": {
      body: {
        ok: true,
        result: {
          template: "Templates/daily.md",
          target: "Daily/2026-06-18.md",
          created_at: "t",
        },
      },
    },
  };

  it("describes that it returns the path Templater actually created", () => {
    v = makeM4Vault({ installed: ["templater"] });
    const tool = v.registry.list().find((candidate) => candidate.name === "execute_template");
    expect(tool?.description).toContain(
      "Returns the vault-relative path Templater actually created",
    );
  });

  it("is HITL-floored: no elicit token => elicit_required before any bridge call", async () => {
    v = makeM4Vault({ installed: ["templater"], routes });
    const res = await v.call("execute_template", input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("elicit_required");
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("runs the template and writes output with a valid elicit token", async () => {
    v = makeM4Vault({ installed: ["templater"], routes });
    const res = await v.callConfirmed("execute_template", input);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as Record<string, unknown>).created_at).toBe("t");
    const req = v.bridgeRequests[0];
    if (!req) throw new Error("expected a bridge request");
    const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
    expect(body.template).toBe("Templates/daily.md");
    expect(body.target).toBe("Daily/2026-06-18.md");
    expect(body.overwrite).toBe(false);
  });

  it("returns the path reported by Templater instead of the requested target", async () => {
    const created = "Daily/created-by-templater.md";
    v = makeM4Vault({
      installed: ["templater"],
      files: { [created]: "created" },
      routes: {
        "POST /obsidian-tc/v1/templater/execute": {
          body: { ok: true, result: { target: created, created_at: "t" } },
        },
      },
    });

    const res = await v.callConfirmed("execute_template", input);

    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as Record<string, unknown>).target).toBe(created);
  });

  it("does not reveal a reported created path outside the read ACL", async () => {
    const created = "Secret/created.md";
    v = makeM4Vault({
      installed: ["templater"],
      files: { [created]: "created" },
      acl: { readPaths: ["Templates/**", "Daily/**"], writePaths: ["Daily/**"] },
      routes: {
        "POST /obsidian-tc/v1/templater/execute": {
          body: { ok: true, result: { target: created, created_at: "t" } },
        },
      },
    });

    const res = await v.callConfirmed("execute_template", input);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("acl_denied");
      // The template already ran; the refusal is about what may be revealed, not about the effect.
      expect(res.error.details).toMatchObject({ effect_committed: true });
    }
  });

  it("reports success for a requested target the caller may write but not read", async () => {
    v = makeM4Vault({
      installed: ["templater"],
      acl: { readPaths: ["Templates/**"], writePaths: ["Daily/**"] },
      routes: {
        "POST /obsidian-tc/v1/templater/execute": {
          body: { ok: true, result: { target: "Daily/2026-06-18.md", created_at: "t" } },
        },
      },
    });

    const res = await v.callConfirmed("execute_template", input);

    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as Record<string, unknown>).target).toBe("Daily/2026-06-18.md");
  });

  it("enforces the target write ACL (after confirmation, before the bridge)", async () => {
    v = makeM4Vault({ installed: ["templater"], routes, acl: { writePaths: ["Allowed/**"] } });
    const res = await v.callConfirmed("execute_template", input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("acl_denied");
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("degrades to plugin_missing when Templater is absent (token present)", async () => {
    v = makeM4Vault({ installed: [] });
    const res = await v.callConfirmed("execute_template", input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_missing");
  });

  it("refuses when the target exists and overwrite is false (data-loss guard, THE-289)", async () => {
    v = makeM4Vault({
      installed: ["templater"],
      routes,
      files: { "Daily/2026-06-18.md": "existing content" },
    });
    const res = await v.callConfirmed("execute_template", input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("note_exists");
    // Refused before the bridge call; the existing note is untouched.
    expect(v.bridgeRequests).toHaveLength(0);
    expect(v.read("Daily/2026-06-18.md")).toBe("existing content");
  });

  it("overwrites the existing target when overwrite is true (forwarded to the companion)", async () => {
    v = makeM4Vault({
      installed: ["templater"],
      routes,
      files: { "Daily/2026-06-18.md": "existing content" },
    });
    const res = await v.callConfirmed("execute_template", { ...input, overwrite: true });
    expect(res.ok).toBe(true);
    const req = v.bridgeRequests[0];
    if (!req) throw new Error("expected a bridge request");
    const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
    expect(body.overwrite).toBe(true);
  });

  // The companion writes `<target>.md` whenever the target does not already end in `.md`
  // (companion templater route). Every server-side judgment must name that file.
  describe("the .md file Templater writes is the one judged", () => {
    const createdRoutes = {
      "POST /obsidian-tc/v1/templater/execute": {
        body: { ok: true, result: { target: "Exports/report.md", created_at: "t" } },
      },
    };
    const exec = (target: string, overwrite = false) => ({
      vault: "test",
      template: "Templates/plain.md",
      target,
      overwrite,
    });

    it("write-checks Exports/report.md, not the extensionless whitelist entry Exports/report", async () => {
      v = makeM4Vault({
        installed: ["templater"],
        routes: createdRoutes,
        acl: { readPaths: ["Templates/**"], writePaths: ["Exports/report"] },
      });
      const res = await v.callConfirmed("execute_template", exec("Exports/report"));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("acl_denied");
      expect(v.bridgeRequests).toHaveLength(0);
    });

    it("derives the suffix case-sensitively, as the companion does (report.MD -> report.MD.md)", async () => {
      v = makeM4Vault({
        installed: ["templater"],
        routes: createdRoutes,
        acl: { readPaths: ["Templates/**"], writePaths: ["Exports/report.MD"] },
      });
      const res = await v.callConfirmed("execute_template", exec("Exports/report.MD"));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("acl_denied");
      expect(v.bridgeRequests).toHaveLength(0);
    });

    it.each(["wiki/log", "wiki/./log", "wiki/log.md"])(
      "hits the implicit wiki/log.md rule for target %s (no read:provenance)",
      async (target) => {
        v = makeM4Vault({
          installed: ["templater"],
          routes: createdRoutes,
          acl: {
            rules: withWikiLogScope({ readOnly: false, defaultScopes: [], rules: [] }, "wiki")
              .rules,
          },
        });
        const res = await v.callConfirmed("execute_template", exec(target, true), {
          grantedScopes: new Set(["write:templater"]),
        });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("acl_denied");
        expect(v.bridgeRequests).toHaveLength(0);
      },
    );

    it("binds the approval to the real .md file: a rewrite after the request is replay_drift", async () => {
      v = makeM4Vault({
        installed: ["templater"],
        routes: createdRoutes,
        files: { "Exports/report.md": "original" },
        bindState: true,
      });
      const input = exec("Exports/report", true);
      const need = await v.call("execute_template", input);
      expect(need.ok).toBe(false);
      if (need.ok) return;
      expect(need.error.code).toBe("elicit_required");
      const argsHash = (need.error.details as { args_hash: string }).args_hash;
      const token = issueElicitToken(v.db, {
        vaultId: "test",
        toolName: "execute_template",
        argsHash,
        caller: "test",
      });

      v.write("Exports/report.md", "rewritten after the request");
      const res = await v.call("execute_template", input, { elicitToken: token });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("replay_drift");
      expect(v.bridgeRequests).toHaveLength(0);
      expect(v.read("Exports/report.md")).toBe("rewritten after the request");
    });

    it("control: an extensionless target permitted as X.md runs, and the bridge gets the canonical path", async () => {
      v = makeM4Vault({
        installed: ["templater"],
        routes: createdRoutes,
        acl: { readPaths: ["Templates/**"], writePaths: ["Exports/**"] },
      });
      const res = await v.callConfirmed("execute_template", exec("Exports/report"));
      expect(res.ok).toBe(true);
      if (res.ok) expect((res.data as Record<string, unknown>).target).toBe("Exports/report.md");
      const req = v.bridgeRequests[0];
      if (!req) throw new Error("expected a bridge request");
      const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
      expect(body.target).toBe("Exports/report.md");
    });
  });
});
