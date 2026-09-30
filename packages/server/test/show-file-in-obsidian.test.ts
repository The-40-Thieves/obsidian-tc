// show_file_in_obsidian — actually OPENS a note, where generate_uri only builds the string.
// Path 1 is the companion bridge (POST /files/open) when a live Obsidian session answers; path 2
// is the OS URI handler, refused unless `uri.allowOsLaunch` is on AND the call arrived over stdio.
// The bridge is the fake transport and the OS launcher is a stub, so every assertion is on the
// exact request / URI handed over. Nothing is silently a success: with neither path available the
// result is `available: false` with a reason and a hint.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { OsLaunchFn } from "../src/tools/m4/os-launch";
import { type M4Vault, makeM4Vault } from "./m4-helpers";

const OPEN_ROUTE = "POST /obsidian-tc/v1/files/open";
const OK_ROUTE = { [OPEN_ROUTE]: { body: { ok: true, result: { opened: true } } } };
const NO_COMPANION = { companion: "missing" as const, plugins: {} };

let v: M4Vault | undefined;
afterEach(() => v?.cleanup());

const launcher = (): OsLaunchFn & ReturnType<typeof vi.fn> =>
  vi.fn(async () => ({ ok: true as const })) as never;

interface Out {
  available: boolean;
  method?: string;
  reason?: string;
  message?: string;
  hint?: string;
  path?: string;
  detail?: string;
}
async function show(
  vault: M4Vault,
  path: string,
  over: Parameters<M4Vault["callConfirmed"]>[2] = {},
): Promise<{ ok: boolean; data?: Out; code?: string }> {
  const res = await vault.callConfirmed("show_file_in_obsidian", { vault: vault.id, path }, over);
  return res.ok
    ? { ok: true, data: res.data as Out }
    : { ok: false, code: (res as { error: { code: string } }).error.code };
}

describe("show_file_in_obsidian — policy", () => {
  it("is HITL-floored (execute:uri): no token => elicit_required, no bridge call, no launch", async () => {
    const osLaunch = launcher();
    v = makeM4Vault({
      files: { "Notes/a.md": "x" },
      routes: OK_ROUTE,
      extra: { osLaunch, uri: { allowOsLaunch: true } },
    });
    const res = await v.call("show_file_in_obsidian", { vault: v.id, path: "Notes/a.md" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("elicit_required");
    expect(v.bridgeRequests).toHaveLength(0);
    expect(osLaunch).not.toHaveBeenCalled();
  });

  it("is registered as an execute-family, non-vault-writing tool with a declared path ACL", () => {
    v = makeM4Vault();
    const def = v.registry.list().find((t) => t.name === "show_file_in_obsidian");
    expect(def?.requiredScopes).toEqual(["execute:uri"]);
    expect(def?.domain).toBe("automation");
    expect(def?.pathAcl?.({ vault: "test", path: "Notes/a.md" })).toEqual([
      { op: "read", path: "Notes/a.md" },
    ]);
  });
});

describe("path 1 — companion bridge", () => {
  it("opens the note through /files/open with the normalized vault-relative path", async () => {
    const osLaunch = launcher();
    v = makeM4Vault({
      files: { "Notes/a.md": "x" },
      routes: OK_ROUTE,
      extra: { osLaunch, uri: { allowOsLaunch: true } },
    });
    const res = await show(v, "Notes//./a.md", { transport: "stdio" });
    expect(res).toMatchObject({
      ok: true,
      data: { available: true, method: "bridge", path: "Notes/a.md" },
    });
    expect(v.bridgeRequests).toHaveLength(1);
    const req = v.bridgeRequests[0];
    expect(req?.method).toBe("POST");
    expect(new URL(req?.url ?? "").pathname).toBe("/obsidian-tc/v1/files/open");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ path: "Notes/a.md" });
    // The bridge is preferred: the OS launcher is never touched when it answered.
    expect(osLaunch).not.toHaveBeenCalled();
  });

  it("sends spaces, unicode and # in the path verbatim as JSON (not URI-encoded)", async () => {
    const rel = "Notes/日本語 ノート #1 (draft).md";
    v = makeM4Vault({ files: { [rel]: "x" }, routes: OK_ROUTE });
    const res = await show(v, rel);
    expect(res.data?.available).toBe(true);
    expect(JSON.parse(v.bridgeRequests[0]?.body ?? "{}")).toEqual({ path: rel });
  });

  it("propagates a bridge-side refusal (note unknown to Obsidian) instead of falling back", async () => {
    const osLaunch = launcher();
    v = makeM4Vault({
      files: { "Notes/a.md": "x" },
      routes: {
        [OPEN_ROUTE]: { body: { ok: false, code: "invalid_input", message: "no such file" } },
      },
      extra: { osLaunch, uri: { allowOsLaunch: true } },
    });
    const res = await show(v, "Notes/a.md", { transport: "stdio" });
    expect(res).toEqual({ ok: false, code: "invalid_input" });
    expect(osLaunch).not.toHaveBeenCalled();
  });

  it("propagates plugin_incompatible (a deliberate update-the-plugin signal) instead of falling back", async () => {
    const osLaunch = launcher();
    v = makeM4Vault({
      files: { "Notes/a.md": "x" },
      snapshot: { companion: "reachable", plugins: {}, apiCompat: "incompatible", apiVersion: "9" },
      extra: { osLaunch, uri: { allowOsLaunch: true } },
    });
    const res = await show(v, "Notes/a.md", { transport: "stdio" });
    expect(res).toEqual({ ok: false, code: "plugin_incompatible" });
    expect(osLaunch).not.toHaveBeenCalled();
  });
});

describe("read ACL and existence — enforced before either path", () => {
  it("refuses a path outside the caller's read ACL (acl_denied) with no bridge call and no launch", async () => {
    const osLaunch = launcher();
    v = makeM4Vault({
      files: { "Private/secret.md": "x", "Public/ok.md": "x" },
      acl: { readPaths: ["Public/**"] },
      routes: OK_ROUTE,
      extra: { osLaunch, uri: { allowOsLaunch: true } },
    });
    const denied = await show(v, "Private/secret.md", { transport: "stdio" });
    expect(denied).toEqual({ ok: false, code: "acl_denied" });
    expect(v.bridgeRequests).toHaveLength(0);
    expect(osLaunch).not.toHaveBeenCalled();
    const allowed = await show(v, "Public/ok.md", { transport: "stdio" });
    expect(allowed.data?.available).toBe(true);
  });

  it("refuses the hard default-deny baseline (.obsidian) even with no ACL rules", async () => {
    v = makeM4Vault({ files: { ".obsidian/app.json": "{}" }, routes: OK_ROUTE });
    const res = await show(v, ".obsidian/app.json");
    expect(res).toEqual({ ok: false, code: "acl_denied" });
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("a missing note is note_not_found, and a folder answers the same way", async () => {
    v = makeM4Vault({ files: { "Notes/a.md": "x" }, routes: OK_ROUTE });
    expect(await show(v, "Notes/missing.md")).toEqual({ ok: false, code: "note_not_found" });
    expect(await show(v, "Notes")).toEqual({ ok: false, code: "note_not_found" });
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("rejects traversal at the schema", async () => {
    v = makeM4Vault({ routes: OK_ROUTE });
    const res = await show(v, "../outside.md");
    expect(res.ok).toBe(false);
    expect(v.bridgeRequests).toHaveLength(0);
  });
});

describe("path 2 — OS URI handler (opt-in, stdio only)", () => {
  const files = { "Notes/a b.md": "x" };

  it("is refused while uri.allowOsLaunch is off (default): unavailable + hint naming the key", async () => {
    const osLaunch = launcher();
    v = makeM4Vault({ files, snapshot: NO_COMPANION, extra: { osLaunch } });
    const res = await show(v, "Notes/a b.md", { transport: "stdio" });
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ available: false, reason: "os_launch_disabled" });
    expect(res.data?.hint).toContain("uri.allowOsLaunch");
    expect(osLaunch).not.toHaveBeenCalled();
  });

  it("is refused while the flag is explicitly false", async () => {
    const osLaunch = launcher();
    v = makeM4Vault({
      files,
      snapshot: NO_COMPANION,
      extra: { osLaunch, uri: { allowOsLaunch: false } },
    });
    const res = await show(v, "Notes/a b.md", { transport: "stdio" });
    expect(res.data).toMatchObject({ available: false, reason: "os_launch_disabled" });
    expect(osLaunch).not.toHaveBeenCalled();
  });

  it.each([["http"], [undefined]])(
    "is refused on a non-stdio transport (%s) even when the flag is on",
    async (transport) => {
      const osLaunch = launcher();
      v = makeM4Vault({
        files,
        snapshot: NO_COMPANION,
        extra: { osLaunch, uri: { allowOsLaunch: true } },
      });
      const res = await show(
        v,
        "Notes/a b.md",
        transport ? { transport: transport as "http" } : {},
      );
      expect(res.data).toMatchObject({ available: false, reason: "os_launch_requires_stdio" });
      expect(res.data?.hint).toContain("stdio");
      expect(osLaunch).not.toHaveBeenCalled();
    },
  );

  it("launches the builder's exact URI over stdio when enabled and no live bridge answers", async () => {
    const osLaunch = launcher();
    v = makeM4Vault({
      files,
      snapshot: NO_COMPANION,
      extra: { osLaunch, uri: { allowOsLaunch: true } },
    });
    const res = await show(v, "Notes/a b.md", { transport: "stdio" });
    expect(res.data).toMatchObject({ available: true, method: "os", path: "Notes/a b.md" });
    expect(osLaunch).toHaveBeenCalledTimes(1);
    // Vault display name = the registry name (defaults to the id), path percent-encoded once.
    expect(osLaunch).toHaveBeenCalledWith("obsidian://open?vault=test&file=Notes%2Fa%20b.md");
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("also falls back when the companion is configured but its endpoint does not answer", async () => {
    const osLaunch = launcher();
    v = makeM4Vault({
      files,
      routes: { [OPEN_ROUTE]: { networkError: true } },
      extra: { osLaunch, uri: { allowOsLaunch: true } },
    });
    const res = await show(v, "Notes/a b.md", { transport: "stdio" });
    expect(res.data).toMatchObject({ available: true, method: "os" });
    expect(v.bridgeRequests).toHaveLength(1);
    expect(osLaunch).toHaveBeenCalledTimes(1);
  });

  it("falls back on a headless vault (mode gate) when the OS path is allowed", async () => {
    const osLaunch = launcher();
    v = makeM4Vault({
      files,
      routes: OK_ROUTE,
      extra: { osLaunch, uri: { allowOsLaunch: true }, mode: () => "headless" },
    });
    const res = await show(v, "Notes/a b.md", { transport: "stdio" });
    expect(res.data).toMatchObject({ available: true, method: "os" });
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("reports a failed launch as unavailable (never a silent success), naming the cause", async () => {
    const osLaunch = vi.fn(async () => ({ ok: false as const, reason: "launcher_not_found" }));
    v = makeM4Vault({
      files,
      snapshot: NO_COMPANION,
      extra: { osLaunch: osLaunch as never, uri: { allowOsLaunch: true } },
    });
    const res = await show(v, "Notes/a b.md", { transport: "stdio" });
    expect(res.data).toMatchObject({
      available: false,
      reason: "os_launch_failed",
      detail: "launcher_not_found",
    });
    expect(res.data?.hint).toBeTruthy();
  });
});

describe("headless server — neither path available", () => {
  it("returns a structured unavailable with a hint, not a success", async () => {
    v = makeM4Vault({
      files: { "Notes/a.md": "x" },
      snapshot: NO_COMPANION,
      extra: { mode: () => "headless" },
    });
    const res = await show(v, "Notes/a.md", { transport: "stdio" });
    expect(res.ok).toBe(true);
    expect(res.data?.available).toBe(false);
    expect(res.data?.reason).toBe("os_launch_disabled");
    expect(res.data?.message).toMatch(/could not open/i);
    expect(res.data?.hint).toMatch(/Obsidian/);
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("an older companion without the route (HTTP 404) gets an update-the-plugin hint", async () => {
    v = makeM4Vault({
      files: { "Notes/a.md": "x" },
      routes: { [OPEN_ROUTE]: { status: 404, body: { not: "an envelope" } } },
    });
    const res = await show(v, "Notes/a.md");
    expect(res.data).toMatchObject({ available: false });
    expect(res.data?.hint).toMatch(/update the companion plugin/i);
  });
});

describe("injection attempts produce one safely-encoded URI", () => {
  // Names legal on every CI OS (no `"`, `?` or newline on Windows) — full set below on POSIX.
  const portable = ["Notes/a & b; $(id) #tag (1).md", "Notes/`id`.md", "Notes/日本語 ノート.md"];
  const posixOnly = [
    'Notes/say "hi".md',
    "Notes/line1\nline2.md",
    "Notes/q?x=1&y=2#frag.md",
    "Notes/$(touch pwned).md",
    "Notes/a|b>c<d*.md",
  ];

  async function launched(rel: string): Promise<string> {
    const osLaunch = launcher();
    v = makeM4Vault({
      files: { [rel]: "x" },
      snapshot: NO_COMPANION,
      extra: { osLaunch, uri: { allowOsLaunch: true } },
    });
    const res = await show(v, rel, { transport: "stdio" });
    expect(res.data).toMatchObject({ available: true, method: "os" });
    expect(osLaunch).toHaveBeenCalledTimes(1);
    const calls = (osLaunch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls[0]).toHaveLength(1); // the URI is the ONLY argument handed to the launcher
    return calls[0]?.[0] as string;
  }

  const check = async (rel: string): Promise<void> => {
    const uri = await launched(rel);
    expect(uri).toMatch(/^obsidian:\/\/open\?vault=test&file=[A-Za-z0-9%._~!*'()-]+$/);
    expect(uri).not.toMatch(/["`;|<>\s$\\]/);
    expect(new URL(uri).searchParams.get("file")).toBe(rel);
  };

  it.each(portable)("%j", check);
  (process.platform === "win32" ? it.skip : it).each(posixOnly)("%j", check);
});
