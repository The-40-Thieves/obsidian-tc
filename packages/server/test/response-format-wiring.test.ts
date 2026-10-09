// tools.defaults.responseFormat through the composition root (`buildServerRuntime`): the only place
// the config and the tool deps meet. A unit test building registerM1Tools itself passes whether or
// not tool-wiring.ts reads the key, so this goes through the real runtime. It also pins that a
// hand-built config lacking `tools` (an embedder bypassing ServerConfigSchema) still wires, and
// gets the shipped default (detailed) rather than a TypeError at startup.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configFromVaultPath } from "../src/cli/args";
import { provisionCacheDb } from "../src/db/provision";
import { buildServerRuntime } from "../src/runtime/server-runtime";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const dirs: string[] = [];
const tmp = (p: string): string => {
  const d = makeTempDir(p);
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      /* a still-open sqlite handle can make Windows refuse the unlink; the assertions have run */
    }
  }
});

type Shape = "default" | "concise" | "detailed" | "no-tools" | "no-defaults";

async function readNoteWith(shape: Shape, args: Record<string, unknown> = {}) {
  const vaultDir = tmp("otc-rf-vault-");
  writeFileSync(join(vaultDir, "n.md"), "---\ntags: [a]\n---\n# N\n\nbody text\n");
  const config = configFromVaultPath(vaultDir);
  config.cacheDir = tmp("otc-rf-cache-");
  const loose = config as unknown as { tools?: { defaults?: unknown } };
  if (shape === "concise" || shape === "detailed") config.tools.defaults.responseFormat = shape;
  if (shape === "no-tools") delete loose.tools;
  if (shape === "no-defaults") delete loose.tools?.defaults;
  const runtime = await buildServerRuntime(config, join(vaultDir, "config.json"));
  try {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const ctx = {
      caller: "test",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "main",
      db,
    };
    const r = await runtime.registry.dispatch(
      "read_note",
      { vault: "main", path: "n.md", ...args },
      ctx as never,
    );
    return (r as { data: Record<string, unknown> }).data;
  } finally {
    await runtime.close("test cleanup");
  }
}

describe("tools.defaults.responseFormat at the composition root", () => {
  it("shipped default is detailed: the frontmatter is returned", async () => {
    const d = await readNoteWith("default");
    expect(d.frontmatter).toEqual({ tags: ["a"] });
  });

  it("concise config default is honoured by a call naming no format", async () => {
    const d = await readNoteWith("concise");
    expect("frontmatter" in d).toBe(false);
    expect(d.body).toContain("body text");
  });

  it("an explicit response_format beats the config default", async () => {
    const d = await readNoteWith("concise", { response_format: "detailed" });
    expect(d.frontmatter).toEqual({ tags: ["a"] });
  });

  it("a hand-built config lacking `tools` wires and behaves as detailed", async () => {
    const d = await readNoteWith("no-tools");
    expect(d.frontmatter).toEqual({ tags: ["a"] });
  });

  it("a hand-built config lacking `tools.defaults` wires and behaves as detailed", async () => {
    const d = await readNoteWith("no-defaults");
    expect(d.frontmatter).toEqual({ tags: ["a"] });
  });
});

// The one `const responseFormat` in tool-wiring.ts feeds M1, M2, M3, M4, M5, M6, M7 and M8 alike; read_note
// above proves M1. These prove the other domains each received it, by the one field per tool
// that only a detailed response carries.
type Step = [tool: string, args: Record<string, unknown>, vaultless?: boolean];

async function lastDataWith(
  shape: "default" | "concise",
  steps: Step[],
  files: Record<string, string>,
  retrieval: { classRouter?: boolean } = {},
  seed?: (db: ReturnType<typeof openMemoryDb>) => void,
): Promise<Record<string, unknown>> {
  const vaultDir = tmp("otc-rf-vault-");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(vaultDir, rel)), { recursive: true });
    writeFileSync(join(vaultDir, rel), content);
  }
  const config = configFromVaultPath(vaultDir);
  config.cacheDir = tmp("otc-rf-cache-");
  if (shape === "concise") config.tools.defaults.responseFormat = "concise";
  if (retrieval.classRouter) config.retrieval.classRouter = true;
  const runtime = await buildServerRuntime(config, join(vaultDir, "config.json"));
  try {
    const db = openMemoryDb();
    provisionCacheDb(db);
    seed?.(db);
    const ctx = {
      caller: "test",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "main",
      db,
    };
    let data: Record<string, unknown> = {};
    for (const [tool, args, vaultless] of steps) {
      const r = (await runtime.registry.dispatch(
        tool,
        vaultless ? args : { vault: "main", ...args },
        ctx as never,
      )) as {
        ok?: boolean;
        data?: Record<string, unknown>;
        error?: unknown;
      };
      if (r.ok === false) throw new Error(`${tool}: ${JSON.stringify(r.error)}`);
      data = r.data ?? {};
    }
    return data;
  } finally {
    await runtime.close("test cleanup");
  }
}

const has = (field: string) => (d: Record<string, unknown>) => field in d;

const DOMAIN_CASES: Array<{
  domain: string;
  steps: Step[];
  files: Record<string, string>;
  /** True for a detailed response, false for a concise one. */
  isDetailed: (d: Record<string, unknown>) => boolean;
  classRouter?: boolean;
  seed?: (db: ReturnType<typeof openMemoryDb>) => void;
}> = [
  {
    domain: "m3 list_attachments",
    steps: [["list_attachments", {}]],
    files: { "assets/pic.png": "png", "n.md": "# N\n" },
    isDetailed: has("total_returned"),
  },
  {
    // registerM4Tools takes its deps as one object, so a dropped `responseFormat,` there is
    // invisible to the type checker (the field is optional): only this case goes red.
    domain: "m4 bundle_files",
    steps: [["bundle_files", { paths: ["n.md"] }]],
    files: { "n.md": "# N\n\nbody\n" },
    isDetailed: has("total_bytes"),
  },
  {
    domain: "m5 list_capture_queue",
    steps: [
      ["enqueue_capture", { content: "a plain note about foxes" }],
      ["list_capture_queue", {}],
    ],
    files: { "n.md": "# N\n" },
    isDetailed: has("total_returned"),
  },
  {
    // m6 builds its deps in runtime/m6-wiring.ts: a dropped `responseFormat,` there is invisible to
    // the type checker (the field is optional), so only this case goes red.
    domain: "m6 inspect_visibility",
    steps: [["inspect_visibility", { tool: "read_note" }, true]],
    files: { "n.md": "# N\n" },
    isDetailed: (d) => "required_scopes" in ((d.tools as Array<Record<string, unknown>>)[0] ?? {}),
  },
  {
    // The lexical route answers without an embedder, so the runtime needs no model backend.
    domain: "m7 vault_graph_search",
    steps: [["vault_graph_search", { query: "quorble", final_top_k: 3 }]],
    files: { "n.md": "# N\n" },
    classRouter: true,
    seed: (db) => {
      db.prepare(
        "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at, acl_path) VALUES ('c1', 'main', 'n.md', 0, '[]', 'the quorble gotcha', 'h1', 5, 1, 1, 'n.md')",
      ).run();
      ensureChunkFts(db, { now: () => 1, enrich: false });
    },
    isDetailed: (d) => {
      const first = (d.results as Array<Record<string, unknown>>)[0];
      if (!first) throw new Error("vault_graph_search returned no hit: the case proves nothing");
      return "source" in first;
    },
  },
  {
    domain: "m8 list_goals",
    steps: [
      ["set_goal", { text: "ship the beta" }],
      ["list_goals", {}],
    ],
    files: { "n.md": "# N\n" },
    isDetailed: has("count"),
  },
];

describe("tools.defaults.responseFormat reaches the m3, m4, m5, m6, m7 and m8 tools", () => {
  for (const c of DOMAIN_CASES) {
    it(`${c.domain}: detailed by default, concise when the config says so`, async () => {
      const run = (shape: "default" | "concise") =>
        lastDataWith(shape, c.steps, c.files, { classRouter: c.classRouter }, c.seed);
      expect(c.isDetailed(await run("default")), "default config is detailed").toBe(true);
      expect(c.isDetailed(await run("concise")), "concise config is concise").toBe(false);
    });
  }
});
