// M5 live-vault integration (THE-181): one real temp vault, one cache DB, the M1 +
// M5 tool surfaces registered on ONE shared ToolRegistry against ONE fake plur
// transport — the exact coexistence cli.ts assembles. Driven end-to-end through
// dispatch: enqueue + list a capture; create two entities + a relation, materialize an
// entity to a note and assert unknown-frontmatter preservation + the [[link]] (read
// back via the M1 read_note tool, proving the surfaces share the registry); append +
// replay a workspace JSONL trace; a plur proxy call against the fake AND its degraded
// path. Asserts DB/file state and event_log audit rows. No live plur, no live Obsidian.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { type FakeRequestInfo, fakeBridgeTransport } from "../src/bridge";
import type { Database } from "../src/db/types";
import { elicitVerifier } from "../src/elicit";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { createPlurClient } from "../src/plur/client";
import { registerM1Tools } from "../src/tools/m1";
import { registerM5Tools } from "../src/tools/m5";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);
const PLUR_TOKEN = "plur-key";

interface IntegrationVault {
  root: string;
  db: Database;
  plurRequests: FakeRequestInfo[];
  read(rel: string): string;
  write(rel: string, content: string): void;
  call(
    name: string,
    input: Record<string, unknown>,
    over?: Partial<CallerContext>,
  ): Promise<ToolResult>;
  events(): Array<{ tool_name: string | null; status: string }>;
  cleanup(): void;
}

function makeVault(opts: { plur?: boolean } = {}): IntegrationVault {
  const root = mkdtempSync(join(tmpdir(), "obtc-m5int-"));
  const id = "test";
  const db = openMemoryDb();
  db.exec(schemaSql);
  const acl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
  const vaultRegistry = new VaultRegistry([{ id, path: root }]);

  const plurRequests: FakeRequestInfo[] = [];
  const plur = opts.plur
    ? createPlurClient({
        endpoint: "http://127.0.0.1:7077",
        apiKey: PLUR_TOKEN,
        fetchFn: fakeBridgeTransport({
          routes: {
            "POST /recall": { body: { ok: true, result: { items: [{ engram_id: "e1" }] } } },
          },
          onRequest: (i) => plurRequests.push(i),
        }),
      })
    : undefined;

  const registry = new ToolRegistry({ verifyElicit: elicitVerifier });
  registerM1Tools(registry, {
    vaultRegistry,
    version: "test",
    startedAt: 0,
    embeddings: { provider: "ollama", model: "nomic-embed-text" },
  });
  registerM5Tools(registry, {
    vaultRegistry,
    plur,
    memoryFolder: () => "memory",
    traceFolder: () => ".obsidian-tc/traces",
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
    root,
    db,
    plurRequests,
    read: (rel) => readFileSync(join(root, rel), "utf8"),
    write: (rel, content) => {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    call: (name, input, over) => registry.dispatch(name, input, ctx(over)),
    events: () =>
      db.prepare("SELECT tool_name, status FROM event_log ORDER BY rowid").all() as Array<{
        tool_name: string | null;
        status: string;
      }>,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function data<T = Record<string, unknown>>(r: ToolResult): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
}

describe("M5 live-vault integration", () => {
  let v: IntegrationVault | undefined;
  afterEach(() => v?.cleanup());

  it("runs the full memory/capture/workspace/plur surface alongside M1 on one registry", async () => {
    v = makeVault({ plur: true });

    // ── Capture ──────────────────────────────────────────────────────────────
    const enq = data<{ capture_id: string }>(
      await v.call("enqueue_capture", { vault: "test", content: "a thought", title: "Idea" }),
    );
    expect(enq.capture_id).toMatch(/^cap_/);
    const list = data<{ items: unknown[] }>(await v.call("list_capture_queue", { vault: "test" }));
    expect(list.items).toHaveLength(1);

    // ── Memory: unknown-frontmatter preservation through materialization ──────
    // A note Obsidian already owns at the entity's path, carrying its own key.
    v.write("memory/person/Ada.md", "---\ncssclasses:\n  - wide\n---\n# stale\n");
    const a = data<{ entity_id: string; vault_path: string }>(
      await v.call("create_entity", {
        vault: "test",
        type: "person",
        name: "Ada",
        observations: ["pioneer"],
      }),
    );
    expect(a.vault_path).toBe("memory/person/Ada.md");
    const b = data<{ entity_id: string }>(
      await v.call("create_entity", { vault: "test", type: "person", name: "Babbage" }),
    );

    // Read the materialized note back through the M1 read_note tool (shared registry).
    const adaRead = data<{ frontmatter: Record<string, unknown>; body: string }>(
      await v.call("read_note", { vault: "test", path: "memory/person/Ada.md" }),
    );
    expect(adaRead.frontmatter.cssclasses).toEqual(["wide"]); // preserved
    expect(adaRead.frontmatter.entity_type).toBe("person"); // owned, regenerated
    expect(adaRead.body).toContain("- pioneer");

    // Link A -> B: re-materializes Ada with the [[Babbage]] link, keeping cssclasses.
    const link = data<{ existed_already: boolean }>(
      await v.call("link_entities", {
        vault: "test",
        source_id: a.entity_id,
        target_id: b.entity_id,
        relation_type: "collaborated_with",
      }),
    );
    expect(link.existed_already).toBe(false);
    const adaNote = v.read("memory/person/Ada.md");
    expect(adaNote).toContain("cssclasses");
    expect(adaNote).toContain("- collaborated_with [[Babbage]]");

    // Graph traversal finds B from A.
    const graph = data<{ items: Array<{ entity_id: string; distance: number }> }>(
      await v.call("query_entity_graph", {
        vault: "test",
        seed_entity_id: a.entity_id,
        direction: "out",
      }),
    );
    expect(graph.items.find((i) => i.entity_id === b.entity_id)?.distance).toBe(1);

    // ── Workspace JSONL trace ────────────────────────────────────────────────
    const s = data<{ session_id: string; trace_path: string }>(
      await v.call("start_session", { vault: "test", caller: "agent" }),
    );
    const end = data<{ event_count: number }>(
      await v.call("end_session", { vault: "test", session_id: s.session_id }),
    );
    expect(end.event_count).toBe(2);
    expect(v.read(s.trace_path)).toContain('"type":"session_start"');
    const traces = data<{ items: Array<{ type?: string }> }>(
      await v.call("get_session_traces", { vault: "test", session_id: s.session_id }),
    );
    expect(traces.items.map((i) => i.type)).toEqual(["session_start", "session_end"]);

    // ── plur proxy (configured, against the fake) ────────────────────────────
    const recall = await v.call("plur_recall", { query: "ada" });
    expect(recall.ok).toBe(true);
    expect(v.plurRequests).toHaveLength(1);
    expect(v.plurRequests[0]?.headers.authorization).toBe(`Bearer ${PLUR_TOKEN}`);

    // ── Audit: every mutating/proxy M5 tool recorded an ok event_log row ─────
    const ev = v.events();
    for (const t of [
      "enqueue_capture",
      "create_entity",
      "link_entities",
      "start_session",
      "end_session",
      "plur_recall",
    ]) {
      expect(ev.some((e) => e.tool_name === t && e.status === "ok")).toBe(true);
    }
  });

  it("degrades the plur proxy to plugin_missing (no network) when plur is unconfigured", async () => {
    v = makeVault({ plur: false });
    const r = await v.call("plur_recall", { query: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("plugin_missing");
    expect(v.plurRequests).toHaveLength(0);
  });
});
