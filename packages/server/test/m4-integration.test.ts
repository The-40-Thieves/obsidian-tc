// M4 live-vault integration: one real temp vault, the full M2 + M4 tool surface
// registered onto ONE shared ToolRegistry against ONE deterministic fake bridge —
// the exact wiring cli.ts assembles (M2 search_dql gets a dataviewBridge closure;
// the nine M4 domains get bridgeFor + the probed capability snapshot, all sharing
// the same client). No live Obsidian, no companion runtime, no community plugin:
// everything proxy-side is exercised through the fake, so this runs in CI and the
// clean room. It complements the per-domain suites by proving the domains coexist
// on the shared registry and that the cross-cutting invariants — scope, ACL, the
// read-only kill-switch, the HITL floors, graceful degradation, and the security
// rule that the bridge bearer token never reaches a result or the audit trail —
// hold uniformly across the mixed surface, driven entirely through dispatch.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import {
  CapabilityCache,
  type CapabilitySnapshot,
  createBridgeClient,
  type FakeRequestInfo,
  type FakeRoute,
  fakeBridgeTransport,
} from "../src/bridge";
import type { Database } from "../src/db/types";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { argsHash } from "../src/hash";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { registerM2Tools } from "../src/tools/m2";
import { registerM4Tools } from "../src/tools/m4";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);

const BASE = "http://127.0.0.1:27124";
const API_KEY = "test-key";
const P = "/obsidian-tc/v1";

// Every community-plugin capability key M4 knows about, so the happy-path vault
// reports the full firepower reachable through the one companion.
const ALL_PLUGINS = [
  "excalidraw",
  "dataview",
  "tasks",
  "templater",
  "quickadd",
  "text-extractor",
  "make-md",
];

interface IntegrationVaultOptions {
  files?: Record<string, string>;
  acl?: Partial<AclConfigT>;
  routes?: Record<string, FakeRoute>;
  snapshot?: CapabilitySnapshot;
  installed?: string[];
  commandPolicy?: (vaultId: string) => { enabled: boolean; allowlist: string[] };
}

interface IntegrationVault {
  db: Database;
  bridgeRequests: FakeRequestInfo[];
  write(rel: string, content: string): void;
  read(rel: string): string;
  call(
    name: string,
    input: Record<string, unknown>,
    over?: Partial<CallerContext>,
  ): Promise<ToolResult>;
  callConfirmed(
    name: string,
    input: Record<string, unknown>,
    over?: Partial<CallerContext>,
  ): Promise<ToolResult>;
  auditDump(): unknown[];
  cleanup(): void;
}

// Build the combined M2 + M4 registry exactly as cli.ts does: one client, one
// request log, one capability snapshot, one vault — shared across both milestones.
function makeVault(opts: IntegrationVaultOptions = {}): IntegrationVault {
  const root = mkdtempSync(join(tmpdir(), "obtc-m4int-"));
  const id = "test";
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (const [rel, content] of Object.entries(opts.files ?? {})) write(rel, content);

  const db = openMemoryDb();
  db.exec(schemaSql);
  const aclCfg: AclConfigT = { readOnly: false, defaultScopes: [], rules: [], ...opts.acl };
  const acl = new FolderAcl(aclCfg);
  const vaultRegistry = new VaultRegistry([{ id, path: root }]);

  const snapshot: CapabilitySnapshot = opts.snapshot ?? {
    companion: "reachable",
    plugins: Object.fromEntries((opts.installed ?? []).map((p) => [p, { installed: true }])),
  };
  const capabilities = new CapabilityCache();
  capabilities.set(id, snapshot);

  const bridgeRequests: FakeRequestInfo[] = [];
  const client = createBridgeClient({
    baseUrl: BASE,
    apiKey: API_KEY,
    fetchFn: fakeBridgeTransport({
      routes: opts.routes ?? {},
      onRequest: (i) => bridgeRequests.push(i),
    }),
  });

  const registry = new ToolRegistry({ verifyElicit: elicitVerifier });
  // M2: search_dql / search_vault(mode:dql) ride the same Dataview bridge client.
  registerM2Tools(registry, {
    vaultRegistry,
    embeddingProvider: fakeEmbeddingProvider({ dimensions: 8 }),
    dataviewBridge: () => ({ client, timeoutMs: 5000 }),
  });
  // M4: nine plugin-bridge domains over the same client + probed snapshot.
  registerM4Tools(registry, {
    vaultRegistry,
    capabilities,
    bridgeFor: () => client,
    ...(opts.commandPolicy ? { commandPolicy: opts.commandPolicy } : {}),
  });

  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: id,
    db,
    acl,
    ...over,
  });

  return {
    db,
    bridgeRequests,
    write,
    read: (rel) => readFileSync(join(root, rel), "utf8"),
    call: (name, input, over) => registry.dispatch(name, input, ctx(over)),
    callConfirmed: (name, input, over) => {
      const token = issueElicitToken(db, {
        vaultId: id,
        toolName: name,
        argsHash: argsHash(name, input),
        caller: "test",
      });
      return registry.dispatch(name, input, ctx({ elicitToken: token, ...over }));
    },
    auditDump: () => db.prepare("SELECT * FROM event_log ORDER BY rowid").all(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const TODO = [
  "# Tasks",
  "",
  "- [ ] write report 📅 2026-06-20 #work ⏫",
  "- [x] buy milk ✅ 2026-06-01 #errand",
  "",
].join("\n");

const HAPPY_FILES: Record<string, string> = {
  "Notes/todo.md": TODO,
  "Notes/a.md": "# A\nalpha\n",
  "Notes/b.md": "# B\nbeta\n",
  "Attach/scan.png": "binary",
};

const HAPPY_ROUTES: Record<string, FakeRoute> = {
  "POST /obsidian-tc/v1/excalidraw/read": {
    body: { ok: true, result: { elements: [{ id: "a" }], text: "hello" } },
  },
  "POST /obsidian-tc/v1/dataview/validate": {
    body: { ok: true, result: { valid: true, ast: { kind: "table" } } },
  },
  "POST /obsidian-tc/v1/tasks/filter": {
    body: { ok: true, result: { items: [{ path: "Notes/todo.md", line: 3 }], groups: [] } },
  },
  "POST /obsidian-tc/v1/dataview/dql": {
    body: {
      ok: true,
      result: { headers: ["File"], rows: [["Notes/a.md"]], note_paths: ["Notes/a.md"] },
    },
  },
  "POST /obsidian-tc/v1/templater/execute": {
    body: { ok: true, result: { created_at: "t", content_hash: "h", expanded_size: 42 } },
  },
  "POST /obsidian-tc/v1/quickadd/trigger": {
    body: { ok: true, result: { fired_at: "t", created_paths: ["Inbox/idea.md"] } },
  },
  "POST /obsidian-tc/v1/ocr/attachment": {
    body: { ok: true, result: { text: "hello world", cached: false, duration_ms: 12 } },
  },
};

describe("M4 integration: M2 search_dql + nine M4 domains on one registry and bridge", () => {
  let v: IntegrationVault | undefined;
  afterEach(() => v?.cleanup());

  it("drives bridge, filesystem, HITL-floored, and cross-milestone tools through dispatch", async () => {
    const vault = makeVault({ files: HAPPY_FILES, installed: ALL_PLUGINS, routes: HAPPY_ROUTES });
    v = vault;
    const results: ToolResult[] = [];
    const drive = async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
      const r = await vault.call(name, input);
      results.push(r);
      return r;
    };

    // ── Bridge read proxies (Excalidraw / Dataview / Tasks) ──
    const rex = await drive("read_excalidraw", {
      vault: "test",
      path: "Drawings/Plan.excalidraw.md",
    });
    expect(rex.ok).toBe(true);
    if (rex.ok) expect((rex.data as Record<string, unknown>).text).toBe("hello");

    expect((await drive("validate_dql", { vault: "test", dql: "TABLE file.name" })).ok).toBe(true);
    expect(
      (await drive("tasks_filter", { vault: "test", filter: "not done", group_by: "status" })).ok,
    ).toBe(true);

    // ── Filesystem-only domains (no bridge, no plugin) ──
    const lt = await drive("list_tasks", { vault: "test" });
    expect(lt.ok).toBe(true);
    if (lt.ok) expect((lt.data as { items: unknown[] }).items.length).toBeGreaterThan(0);

    const bf = await drive("bundle_folder", { vault: "test", root: "Notes" });
    expect(bf.ok).toBe(true);
    if (bf.ok) expect((bf.data as Record<string, unknown>).file_count).toBe(3);

    // ── Cross-milestone: M2 search_dql rides the SAME Dataview bridge ──
    const sd = await drive("search_dql", { vault: "test", dql: "TABLE file.name" });
    expect(sd.ok).toBe(true);
    if (sd.ok) expect((sd.data as Record<string, unknown>).note_paths).toEqual(["Notes/a.md"]);

    // ── HITL floor: execute_template needs a token; denied first, no bridge call ──
    const tplInput = { vault: "test", template: "Templates/daily.md", target: "Daily/x.md" };
    const tplDenied = await drive("execute_template", tplInput);
    expect(tplDenied.ok).toBe(false);
    if (!tplDenied.ok) expect(tplDenied.error.code).toBe("elicit_required");
    const beforeConfirm = vault.bridgeRequests.length;

    const tplOk = await vault.callConfirmed("execute_template", tplInput);
    results.push(tplOk);
    expect(tplOk.ok).toBe(true);
    if (tplOk.ok) expect((tplOk.data as Record<string, unknown>).expanded_size).toBe(42);
    expect(vault.bridgeRequests.length).toBe(beforeConfirm + 1);

    // ── HITL floor: trigger_quickadd (execute:quickadd) ──
    const qaOk = await vault.callConfirmed("trigger_quickadd", {
      vault: "test",
      action_name: "Capture Idea",
    });
    results.push(qaOk);
    expect(qaOk.ok).toBe(true);

    // ── Bridge read with server-side existence guard (OCR) ──
    const ocr = await drive("ocr_attachment", { vault: "test", path: "Attach/scan.png" });
    expect(ocr.ok).toBe(true);
    if (ocr.ok) expect((ocr.data as Record<string, unknown>).text).toBe("hello world");

    // ── Proxy fidelity: exactly the bridge-hitting calls reached the companion,
    //    in order; filesystem and HITL-denied calls added nothing. ──
    expect(vault.bridgeRequests.map((r) => new URL(r.url).pathname)).toEqual([
      `${P}/excalidraw/read`,
      `${P}/dataview/validate`,
      `${P}/tasks/filter`,
      `${P}/dataview/dql`,
      `${P}/templater/execute`,
      `${P}/quickadd/trigger`,
      `${P}/ocr/attachment`,
    ]);
    // The bearer token reaches every transport header (it is meant for the companion).
    for (const r of vault.bridgeRequests) expect(r.headers.authorization).toBe(`Bearer ${API_KEY}`);

    // ── Audit: one row per dispatch, the denied template recorded as an error. ──
    const audit = vault.auditDump() as Array<{
      tool_name: string;
      status: string;
      error_code: string | null;
    }>;
    expect(audit.length).toBe(results.length);
    expect(
      audit
        .filter((e) => e.tool_name === "execute_template")
        .map((e) => e.status)
        .sort(),
    ).toEqual(["error", "ok"]);
    expect(
      audit.some((e) => e.tool_name === "execute_template" && e.error_code === "elicit_required"),
    ).toBe(true);
    for (const t of ["read_excalidraw", "search_dql", "trigger_quickadd", "ocr_attachment"])
      expect(audit.some((e) => e.tool_name === t && e.status === "ok")).toBe(true);

    // ── Security invariant: the bridge key never leaks into a result or the audit. ──
    expect(JSON.stringify(results)).not.toContain(API_KEY);
    expect(JSON.stringify(vault.auditDump())).not.toContain(API_KEY);
  });

  it("enforces scope, ACL, and the read-only kill-switch uniformly across the mixed surface", async () => {
    v = makeVault({ files: HAPPY_FILES, installed: ALL_PLUGINS, routes: HAPPY_ROUTES });

    // Scope: a caller missing read:excalidraw is refused before any bridge call.
    const scoped = await v.call(
      "read_excalidraw",
      { vault: "test", path: "Drawings/Plan.excalidraw.md" },
      { grantedScopes: new Set(["read:notes"]) },
    );
    expect(scoped.ok).toBe(false);
    if (!scoped.ok) expect(scoped.error.code).toBe("forbidden");
    expect(v.bridgeRequests).toHaveLength(0);

    // Read-only kill-switch: a mutating tool (write:tasks) is blocked, but a read
    // tool in the same vault still works — proving the switch is mutation-scoped.
    const ro = new FolderAcl({ readOnly: true, defaultScopes: [], rules: [] });
    const blocked = await v.call(
      "update_task",
      { vault: "test", path: "Notes/todo.md", line: 3, set: { status: "done" } },
      { acl: ro },
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("forbidden");
    expect((await v.call("list_tasks", { vault: "test" }, { acl: ro })).ok).toBe(true);
  });

  it("applies the read ACL to both a filesystem and a bridge tool", async () => {
    v = makeVault({
      files: HAPPY_FILES,
      installed: ALL_PLUGINS,
      routes: HAPPY_ROUTES,
      acl: { readPaths: ["Notes/**"] },
    });

    // Filesystem tool: a path outside the whitelist is denied.
    const fsDenied = await v.call("bundle_files", {
      vault: "test",
      paths: ["Notes/a.md", "Other/x.md"],
    });
    expect(fsDenied.ok).toBe(false);
    if (!fsDenied.ok) expect(fsDenied.error.code).toBe("acl_denied");

    // Bridge tool: the same whitelist gates the proxy before the network call.
    const brDenied = await v.call("ocr_attachment", { vault: "test", path: "Attach/scan.png" });
    expect(brDenied.ok).toBe(false);
    if (!brDenied.ok) expect(brDenied.error.code).toBe("acl_denied");
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("degrades a bridge tool while a filesystem tool keeps working in the same vault", async () => {
    // Companion reachable, but Dataview is not installed.
    v = makeVault({
      files: HAPPY_FILES,
      snapshot: { companion: "reachable", plugins: {} },
      routes: HAPPY_ROUTES,
    });
    const dv = await v.call("validate_dql", { vault: "test", dql: "LIST" });
    expect(dv.ok).toBe(false);
    if (!dv.ok) expect(dv.error.code).toBe("plugin_missing");
    expect(v.bridgeRequests).toHaveLength(0);

    // Smart Context needs neither companion nor plugin — it still works.
    expect((await v.call("bundle_folder", { vault: "test", root: "Notes" })).ok).toBe(true);
  });

  it("list_commands falls back to LRA, then degrades to plugin_unreachable when neither answers", async () => {
    v = makeVault({ snapshot: { companion: "unreachable", plugins: {} } });
    const res = await v.call("list_commands", { vault: "test" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_unreachable");
    // The companion prefix is never called (the snapshot short-circuits it); only the
    // LRA-native /commands/ fallback is attempted, and it too has no route in this fake.
    const hitCompanion = v.bridgeRequests.some((r) =>
      new URL(r.url).pathname.startsWith("/obsidian-tc/v1"),
    );
    expect(hitCompanion).toBe(false);
  });

  it("keeps the command palette deny-by-default even with a token on the shared registry", async () => {
    // The companion is reachable and the caller confirms — but execution is not
    // enabled, so the most dangerous tool stays inert and never reaches the bridge.
    v = makeVault({
      installed: ALL_PLUGINS,
      routes: {
        "POST /obsidian-tc/v1/commands/execute": {
          body: { ok: true, result: { fired_at: "t", plugin_response: { ok: true } } },
        },
      },
    });
    const res = await v.callConfirmed("execute_command", {
      vault: "test",
      command_id: "editor:save-file",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("execute_command_disabled");
    expect(v.bridgeRequests).toHaveLength(0);
  });
});
