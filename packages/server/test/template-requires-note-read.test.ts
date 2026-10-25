// A caller-named template is content the caller gets copied into a note it can then read, so naming
// one needs read:notes. The configured periodic template is the operator's choice and stays exempt.
import { afterEach, describe, expect, it } from "vitest";
import { type M3Vault, makeM3Vault } from "./m3-helpers";
import { type M4Vault, makeM4Vault } from "./m4-helpers";

const SECRET = "PIN 4821\n";
const PERIODIC = new Set(["write:periodic"]);
const PERIODIC_AND_READ = new Set(["write:periodic", "read:notes"]);
const daily = { vault: "test", period: "daily", date: "2026-06-18" };

let m3: M3Vault | undefined;
let m4: M4Vault | undefined;
afterEach(() => {
  m3?.cleanup();
  m3 = undefined;
  m4?.cleanup();
  m4 = undefined;
});

describe("create_periodic_note with a caller-named template_override needs read:notes", () => {
  it("a writer without read:notes is refused and no note is created", async () => {
    m3 = makeM3Vault({ files: { "templates/secret.md": SECRET }, conventions: true });
    const r = await m3.call(
      "create_periodic_note",
      { ...daily, template_override: "templates/secret.md" },
      { grantedScopes: PERIODIC },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("forbidden");
    expect(JSON.stringify(r)).not.toContain("PIN 4821");
    expect(m3.exists("2026-06-18.md")).toBe(false);
  });

  it("a missing template_override gets the same refusal as an existing one (no existence oracle)", async () => {
    m3 = makeM3Vault({ files: {}, conventions: true });
    const r = await m3.call(
      "create_periodic_note",
      { ...daily, template_override: "templates/missing.md" },
      { grantedScopes: PERIODIC },
    );
    m3.cleanup();
    m3 = makeM3Vault({ files: { "templates/secret.md": SECRET }, conventions: true });
    const existing = await m3.call(
      "create_periodic_note",
      { ...daily, template_override: "templates/secret.md" },
      { grantedScopes: PERIODIC },
    );
    expect(r.ok).toBe(false);
    expect(existing.ok).toBe(false);
    if (!r.ok && !existing.ok) {
      expect(r.error.code).toBe(existing.error.code);
      expect(r.error.message).toBe(existing.error.message);
    }
  });

  it("a caller with read:notes still creates the note from the override", async () => {
    m3 = makeM3Vault({ files: { "templates/daily.md": "# Daily\n" }, conventions: true });
    const r = await m3.call(
      "create_periodic_note",
      { ...daily, template_override: "templates/daily.md" },
      { grantedScopes: PERIODIC_AND_READ },
    );
    expect(r.ok).toBe(true);
    expect(m3.read("2026-06-18.md")).toBe("# Daily\n");
  });

  it("a rule-denied template is refused by the handler's read check, before loadTemplate's ACL error", async () => {
    // No central pathAcl stage here (no conventions wiring), so the handler is the first reader.
    m3 = makeM3Vault({
      files: { "templates/secret.md": SECRET },
      acl: { rules: [{ glob: "templates/**", scopes: ["read:templates"] }] },
    });
    const r = await m3.call(
      "create_periodic_note",
      { ...daily, template_override: "templates/secret.md" },
      { grantedScopes: PERIODIC_AND_READ },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid_input");
    expect(JSON.stringify(r)).not.toContain("PIN 4821");
    expect(m3.exists("2026-06-18.md")).toBe(false);
  });

  it("the configured periodic template stays exempt: a writer without read:notes still gets it", async () => {
    m3 = makeM3Vault({
      files: {
        ".obsidian/plugins/periodic-notes/data.json": JSON.stringify({
          daily: { template: "templates/day.md" },
        }),
        "templates/day.md": "# Configured\n",
      },
      conventions: true,
    });
    const r = await m3.call("create_periodic_note", daily, { grantedScopes: PERIODIC });
    expect(r.ok).toBe(true);
    expect(m3.read("2026-06-18.md")).toBe("# Configured\n");
  });
});

describe("execute_template needs read:notes", () => {
  const input = { vault: "test", template: "Templates/daily.md", target: "Daily/2026-06-18.md" };
  const routes = {
    "POST /obsidian-tc/v1/templater/execute": {
      body: {
        ok: true,
        result: { template: "Templates/daily.md", target: "Daily/2026-06-18.md", created_at: "t" },
      },
    },
  };

  it("a write:templater caller without read:notes is refused by the scope gate, not HITL, with no state_fp", async () => {
    m4 = makeM4Vault({ installed: ["templater"], routes, conventions: true, bindState: true });
    const r = await m4.call("execute_template", input, {
      grantedScopes: new Set(["write:templater"]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("forbidden");
      expect(r.error.details).not.toHaveProperty("state_fp");
    }
    expect(m4.bridgeRequests).toHaveLength(0);
  });

  it("guard: with read:notes the same call reaches HITL and carries a state_fp", async () => {
    m4 = makeM4Vault({ installed: ["templater"], routes, conventions: true, bindState: true });
    const r = await m4.call("execute_template", input, {
      grantedScopes: new Set(["write:templater", "read:notes"]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("elicit_required");
      expect(typeof (r.error.details as { state_fp?: unknown }).state_fp).toBe("string");
    }
    expect(m4.bridgeRequests).toHaveLength(0);
  });

  it("a rule-scoped read denial on the template is refused before the bridge is called", async () => {
    m4 = makeM4Vault({
      installed: ["templater"],
      routes,
      conventions: true,
      files: { "Templates/daily.md": SECRET },
      acl: { rules: [{ glob: "Templates/**", scopes: ["read:templates"] }] },
    });
    const r = await m4.callConfirmed("execute_template", input, {
      grantedScopes: new Set(["write:templater", "read:notes"]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("acl_denied");
    expect(m4.bridgeRequests).toHaveLength(0);
  });
});
