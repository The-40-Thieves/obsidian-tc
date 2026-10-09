// reflect's `citation_style` and `detail` arguments. Pins: the default prompt is BYTE-IDENTICAL to
// the string that shipped before the arguments existed; wikilink mode renders `[[path]]` from the
// evidence items in both the returned answer and the persisted note (deterministic post-process,
// not a model behaviour); an out-of-range [n] is left as-is and reported; `detail` changes the
// prompt; and precedence is call argument > per-vault config > default.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VaultConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterAll, describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import type { GatewayCompletionRequest, GatewayRoles } from "../src/plane/gateway";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { registerM7Tools } from "../src/tools/m7";
import {
  REFLECT_SYSTEM_PROMPT,
  reflectSystemPrompt,
  renderWikilinkCitations,
} from "../src/tools/m7/knowledge/retrieval-runtime";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb, stampAclPath } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const NOW = 1_700_000_000_000;

/** The exact string REFLECT_SYSTEM_PROMPT held before citation_style/detail existed. Copied
 *  verbatim, never derived from the code under test. */
const PRE_CHANGE_PROMPT =
  "You synthesize a grounded answer from the user's own notes. Use ONLY the numbered evidence " +
  "chunks; cite them inline as [n]; state plainly what the evidence does not establish. " +
  "Concise, factual, no filler.";

function cacheDb0() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const ins = db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'main', ?, 0, '[]', ?, ?, 40, ?, ?)",
  );
  ins.run("c1", "notes/topic.md", "the quorble pattern part one", "h1", NOW, NOW);
  ins.run("c2", "notes/other.md", "the quorble pattern part two", "h2", NOW, NOW);
  stampAclPath(db);
  ensureChunkFts(db, { now: () => NOW, enrich: false });
  return db;
}

function un<T>(r: unknown): T {
  return (r as { data: T }).data;
}

const root = makeTempDir("obtc-reflect-style-");
afterAll(() => rmTemp(root));

interface Captured {
  req?: GatewayCompletionRequest;
}

function harness(
  synthText: string,
  opts: {
    scopes?: string[];
    reflectDefaults?: (vaultId: string) => { citationStyle?: any; detail?: any };
    memoryDefense?: (vaultId: string) => { mode: "off" | "redact" | "block"; pii: boolean };
  } = {},
) {
  const captured: Captured = {};
  const roles: GatewayRoles = {
    extract: async () => ({ text: "{}", model: "mock" }),
    synthesize: async (req) => {
      captured.req = req;
      return { text: synthText, model: "mock-synth" };
    },
    judge: async () => ({ text: "{}", model: "mock-judge" }),
  };
  const registry = new ToolRegistry({});
  const vaultRegistry = new VaultRegistry([{ id: "main", name: "main", path: root }]);
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider: {
      provider: "ollama",
      model: "stub",
      embed: async () => {
        throw new Error("embed must not be called");
      },
    } as any,
    reranker: null,
    roles,
    classRouter: true,
    ...(opts.reflectDefaults ? { reflectDefaults: opts.reflectDefaults } : {}),
    ...(opts.memoryDefense ? { memoryDefense: opts.memoryDefense } : {}),
  });
  const ctx = {
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(opts.scopes ?? ["read:notes"]),
    vaultId: "main",
    db: cacheDb0(),
    now: () => NOW,
  };
  return { registry, ctx, captured };
}

interface ReflectData {
  answer?: string | null;
  persisted?: { path: string };
  unresolved_citations?: number[];
}

const system = (c: Captured) => c.req?.messages.find((m) => m.role === "system")?.content;

describe("reflect default prompt is byte-identical", () => {
  it("REFLECT_SYSTEM_PROMPT and reflectSystemPrompt() equal the pre-change string", () => {
    expect(REFLECT_SYSTEM_PROMPT).toBe(PRE_CHANGE_PROMPT);
    expect(reflectSystemPrompt()).toBe(PRE_CHANGE_PROMPT);
    expect(reflectSystemPrompt({ citationStyle: "numeric", detail: "concise" })).toBe(
      PRE_CHANGE_PROMPT,
    );
  });

  it("the handler sends that exact string, and no maxTokens, when both args are omitted", async () => {
    const { registry, ctx, captured } = harness("the grounded answer [1]");
    const res = un<ReflectData>(
      await registry.dispatch("reflect", { vault: "main", query: "quorble pattern" }, ctx),
    );
    expect(system(captured)).toBe(PRE_CHANGE_PROMPT);
    expect(captured.req?.maxTokens).toBeUndefined();
    // numeric mode never touches the model text
    expect(res.answer).toBe("the grounded answer [1]");
    expect(res.unresolved_citations).toBeUndefined();
  });
});

describe("reflect citation_style", () => {
  it("numeric (explicit) leaves the answer and the persisted note as the model wrote them", async () => {
    const { registry, ctx } = harness("claim [1] and claim [2]", {
      scopes: ["read:notes", "write:notes"],
    });
    const res = un<ReflectData>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: "quorble numeric", citation_style: "numeric", persist: true },
        ctx,
      ),
    );
    expect(res.answer).toBe("claim [1] and claim [2]");
    expect(readFileSync(join(root, res.persisted?.path ?? ""), "utf8")).toContain(
      "claim [1] and claim [2]",
    );
  });

  it("wikilink renders [[path]] from the evidence items in the answer and the persisted note", async () => {
    const { registry, ctx, captured } = harness("first [1], second [2], again [1].", {
      scopes: ["read:notes", "write:notes"],
    });
    const res = un<ReflectData & { sources: Array<{ path: string }> }>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: "quorble wikilink", citation_style: "wikilink", persist: true },
        ctx,
      ),
    );
    // the prompt the model saw still numbers the evidence; the rendering is ours
    const user = captured.req?.messages.find((m) => m.role === "user")?.content ?? "";
    const pathOf = (n: number) => new RegExp(`\\[${n}\\] (\\S+\\.md)`).exec(user)?.[1] ?? "";
    const p1 = pathOf(1).replace(/\.md$/, "");
    const p2 = pathOf(2).replace(/\.md$/, "");
    expect(p1).not.toBe("");
    expect(p2).not.toBe("");
    const want = `first [[${p1}]], second [[${p2}]], again [[${p1}]].`;
    expect(res.answer).toBe(want);
    expect(res.unresolved_citations).toBeUndefined();
    const note = readFileSync(join(root, res.persisted?.path ?? ""), "utf8");
    expect(note).toContain(want);
    expect(note).not.toMatch(/\[\d+\]/);
  });

  it("wikilink: an [n] with no matching item is left as-is and reported, valid ones still render", async () => {
    const { registry, ctx } = harness("ok [1] ghost [9] ghost again [9] and [0].", {
      scopes: ["read:notes", "write:notes"],
    });
    const res = un<ReflectData>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: "quorble range", citation_style: "wikilink", persist: true },
        ctx,
      ),
    );
    expect(res.answer).toMatch(/^ok \[\[[^\]]+\]\] ghost \[9\] ghost again \[9\] and \[0\]\.$/);
    expect(res.unresolved_citations).toEqual([0, 9]);
    const note = readFileSync(join(root, res.persisted?.path ?? ""), "utf8");
    expect(note).toContain("ghost [9] ghost again [9] and [0].");
  });

  it("wikilink prompt still numbers citations as [n] (the model is not trusted to emit links)", async () => {
    const { registry, ctx, captured } = harness("x [1]");
    await registry.dispatch(
      "reflect",
      { vault: "main", query: "quorble prompt", citation_style: "wikilink" },
      ctx,
    );
    expect(system(captured)).toContain("cite them inline as [n]");
    expect(system(captured)).not.toBe(PRE_CHANGE_PROMPT);
  });

  it("the persisted wikilink note still goes through memoryDefense", async () => {
    const { registry, ctx } = harness("key AKIAABCDEFGHIJKLMNOP see [1]", {
      scopes: ["read:notes", "write:notes"],
      memoryDefense: () => ({ mode: "block", pii: false }),
    });
    const res = (await registry.dispatch(
      "reflect",
      { vault: "main", query: "quorble defended", citation_style: "wikilink", persist: true },
      ctx,
    )) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(existsSync(join(root, "memory", "reflections", "2023-11-14-quorble-defended.md"))).toBe(
      false,
    );
  });
});

describe("renderWikilinkCitations", () => {
  const items = [
    { citation: 1, path: "a/one.md" },
    { citation: 2, path: "b/two.md" },
  ];
  it("maps [n] to [[path]] (extension dropped) and reports unknown numbers once each, sorted", () => {
    expect(renderWikilinkCitations("a [2] b [1] c [7] d [7] e [3]", items)).toEqual({
      text: "a [[b/two]] b [[a/one]] c [7] d [7] e [3]",
      unresolved: [3, 7],
    });
  });
  it("leaves existing wikilinks, markdown links and non-citation brackets alone", () => {
    const src = "see [[1]] and [1](http://x) and [x] and [1.5]";
    expect(renderWikilinkCitations(src, items)).toEqual({ text: src, unresolved: [] });
  });
});

describe("reflect detail", () => {
  it("each level changes the system prompt; concise is the baseline, others are distinct", async () => {
    const seen: Record<string, string> = {};
    for (const detail of ["concise", "standard", "thorough"] as const) {
      const { registry, ctx, captured } = harness("x [1]");
      await registry.dispatch(
        "reflect",
        { vault: "main", query: `quorble detail ${detail}`, detail },
        ctx,
      );
      seen[detail] = system(captured) ?? "";
    }
    expect(seen.concise).toBe(PRE_CHANGE_PROMPT);
    expect(seen.standard).not.toBe(PRE_CHANGE_PROMPT);
    expect(seen.thorough).not.toBe(PRE_CHANGE_PROMPT);
    expect(seen.standard).not.toBe(seen.thorough);
    // the grounding contract is intact at every level; only the style clause moves
    for (const p of Object.values(seen)) {
      expect(p).toContain("Use ONLY the numbered evidence chunks");
      expect(p).toContain("state plainly what the evidence does not establish");
    }
    expect(seen.standard).not.toMatch(/Concise/);
    expect(seen.thorough).not.toMatch(/Concise/);
  });

  it("does not cap the output: no maxTokens at any level (a cap would truncate thorough answers)", async () => {
    const { registry, ctx, captured } = harness("x [1]");
    await registry.dispatch(
      "reflect",
      { vault: "main", query: "quorble uncapped", detail: "thorough" },
      ctx,
    );
    expect(captured.req?.maxTokens).toBeUndefined();
  });

  it("rejects an unknown detail / citation_style value", async () => {
    const { registry, ctx } = harness("x");
    const a = (await registry.dispatch(
      "reflect",
      { vault: "main", query: "quorble bad", detail: "verbose" },
      ctx,
    )) as { ok: boolean };
    const b = (await registry.dispatch(
      "reflect",
      { vault: "main", query: "quorble bad", citation_style: "footnote" },
      ctx,
    )) as { ok: boolean };
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
  });
});

describe("reflect per-vault default precedence", () => {
  const vaultCfg = () => ({ citationStyle: "wikilink" as const, detail: "thorough" as const });

  it("vault config applies when the call omits the args", async () => {
    const { registry, ctx, captured } = harness("see [1]", { reflectDefaults: vaultCfg });
    const res = un<ReflectData>(
      await registry.dispatch("reflect", { vault: "main", query: "quorble vaultcfg" }, ctx),
    );
    expect(res.answer).toMatch(/^see \[\[[^\]]+\]\]$/);
    expect(system(captured)).not.toBe(PRE_CHANGE_PROMPT);
    expect(system(captured)).toBe(
      reflectSystemPrompt({ citationStyle: "wikilink", detail: "thorough" }),
    );
  });

  it("a call argument beats the vault config, per key", async () => {
    const { registry, ctx, captured } = harness("see [1]", { reflectDefaults: vaultCfg });
    const res = un<ReflectData>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: "quorble callarg", citation_style: "numeric", detail: "concise" },
        ctx,
      ),
    );
    expect(res.answer).toBe("see [1]");
    expect(system(captured)).toBe(PRE_CHANGE_PROMPT);

    const mixed = harness("see [1]", { reflectDefaults: vaultCfg });
    const r2 = un<ReflectData>(
      await mixed.registry.dispatch(
        "reflect",
        { vault: "main", query: "quorble mixed", detail: "standard" },
        mixed.ctx,
      ),
    );
    // citation_style from the vault (wikilink), detail from the call (standard)
    expect(r2.answer).toMatch(/^see \[\[[^\]]+\]\]$/);
    expect(system(mixed.captured)).toBe(
      reflectSystemPrompt({ citationStyle: "wikilink", detail: "standard" }),
    );
  });

  it("an unset vault config falls through to the shipped defaults", async () => {
    const { registry, ctx, captured } = harness("see [1]", { reflectDefaults: () => ({}) });
    const res = un<ReflectData>(
      await registry.dispatch("reflect", { vault: "main", query: "quorble unset" }, ctx),
    );
    expect(res.answer).toBe("see [1]");
    expect(system(captured)).toBe(PRE_CHANGE_PROMPT);
  });
});

describe("vaults[].reflect config", () => {
  const base = { id: "main", path: "/tmp/v" };
  it("parses with no defaults applied: an unset key stays unset so precedence can fall through", () => {
    expect(VaultConfigSchema.parse(base).reflect).toBeUndefined();
    expect(VaultConfigSchema.parse({ ...base, reflect: {} }).reflect).toEqual({});
    expect(
      VaultConfigSchema.parse({
        ...base,
        reflect: { citationStyle: "wikilink", detail: "standard" },
      }).reflect,
    ).toEqual({ citationStyle: "wikilink", detail: "standard" });
  });
  it("rejects a value outside the enums", () => {
    expect(VaultConfigSchema.safeParse({ ...base, reflect: { detail: "verbose" } }).success).toBe(
      false,
    );
    expect(
      VaultConfigSchema.safeParse({ ...base, reflect: { citationStyle: "footnote" } }).success,
    ).toBe(false);
  });
});
