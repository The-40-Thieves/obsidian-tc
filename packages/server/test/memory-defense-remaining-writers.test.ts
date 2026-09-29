// Per-writer behavioral tests for the note-content writers memoryDefense.test.ts's
// own "block mode — real wiring" table does NOT cover: bulk_create_notes/bulk_set_property/
// bulk_move_notes, restore_note, update_task, insert_table_row, create_periodic_note/
// append_to_periodic_note, reflect's persist primitive (persistGovernedNote), and
// commit_capture's target_path normalization edge (a match found only after NFKC folding).
// Each block-mode case asserts BOTH the refusal (secret_detected) AND that nothing landed on
// disk; one redact-mode case (bulk_create_notes) asserts the persisted form is the redacted one,
// not the raw secret.
//
// Real wiring throughout (buildServerRuntime + configFromVaultPath), same composition root
// memory-defense.test.ts's own "block mode — real wiring" section uses — see that file's header
// comment for why (catches wiring gaps a hand-built registry misses).
//
// Every secret/PII value below is assembled at RUNTIME (string concatenation), never a single
// literal in source that itself matches a SECRET_PATTERNS or PII regex — same house rule
// memory-defense.test.ts documents in its own header.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObsidianTcError, type ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { configFromVaultPath } from "../src/cli/args";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { issueElicitToken } from "../src/elicit";
import type { CallerContext } from "../src/mcp/registry";
import { ToolRegistry } from "../src/mcp/registry";
import type { GatewayRoles } from "../src/plane/gateway";
import { buildServerRuntime, type ServerRuntime } from "../src/runtime/server-runtime";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { registerM7Tools } from "../src/tools/m7";
import { persistGovernedNote } from "../src/vault/persist-note";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

// ---------------------------------------------------------------------------------------------
// Secret builders — every one assembled at runtime from pieces that are not individually
// secret-shaped, mirroring memory-defense.test.ts's own fakeOpenAiKey/fakeAwsKeyId.
// ---------------------------------------------------------------------------------------------

function fakeOpenAiKey(): string {
  return ["sk", "-", "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
}

// leaf-scan-normalization.test.ts's own fixture: full-width Latin letters (U+FF21 'Ａ', U+FF2B
// 'Ｋ', U+FF29 'Ｉ') do NOT match `\bAKIA[0-9A-Z]{16}\b` raw — NFKC folds them to plain ASCII
// "AKIA" before the aws_access_key_id pattern ever sees the text. Path-safe (letters/digits only,
// no invisible codepoints), so it doubles as a normalization fixture for a vault PATH.
function fakeFullWidthAkiaPathSegment(): string {
  const fullWidthAkia = ["Ａ", "Ｋ", "Ｉ", "Ａ"].join("");
  return [fullWidthAkia, "Q7W8E9R0T1Y2U3I4"].join("");
}

// ---------------------------------------------------------------------------------------------
// Envelope helpers — same shape as memory-defense.test.ts's own un()/errOf().
// ---------------------------------------------------------------------------------------------

function un<T>(r: ToolResult): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
}

function errOf(r: ToolResult): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (r.ok) throw new Error("expected an error result");
  return r.error as { code: string; message: string; details?: Record<string, unknown> };
}

// ---------------------------------------------------------------------------------------------
// Real-wiring harness: buildServerRuntime + configFromVaultPath, exactly memory-defense.test.ts's
// own "block mode — real wiring" section. `withHarness` owns setup/teardown so each `it` gets an
// isolated vault + cache dir and the runtime is always closed, even on assertion failure.
// ---------------------------------------------------------------------------------------------

interface Harness {
  vaultDir: string;
  runtime: ServerRuntime;
  ctx: CallerContext;
}

async function withHarness(
  mode: "block" | "redact",
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const vaultDir = mkdtempSync(join(tmpdir(), "otc-memdef-rw-vault-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "otc-memdef-rw-cache-"));
  const config = configFromVaultPath(vaultDir);
  config.cacheDir = cacheDir;
  const vault = config.vaults[0];
  if (!vault) throw new Error("configFromVaultPath did not return a vault");
  vault.memoryDefense = { mode, pii: true };
  const runtime = await buildServerRuntime(config, join(vaultDir, "config.json"));
  const db: Database = openMemoryDb();
  provisionCacheDb(db);
  const ctx: CallerContext = {
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "main",
    db,
  };
  try {
    await fn({ vaultDir, runtime, ctx });
  } finally {
    await runtime.close("test cleanup");
    db.close?.();
    // best-effort, same concession server-runtime.test.ts makes — a still-open handle (or a
    // Windows AV/indexer lock) on one temp dir must never turn an otherwise-passing test red.
    try {
      rmTemp(vaultDir);
    } catch {
      /* best-effort */
    }
    try {
      rmTemp(cacheDir);
    } catch {
      /* best-effort */
    }
  }
}

/** Dispatches `name`; if it comes back `elicit_required`, mints a token from the error's own
 *  `args_hash` and retries once — the same two-step recipe snapshots.test.ts's restore_note case
 *  uses, which sidesteps needing to hand-derive argsHash(toolName, input) ourselves. */
async function confirmed(
  h: Harness,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const first = await h.runtime.registry.dispatch(name, input, h.ctx);
  if (first.ok || first.error.code !== "elicit_required") return first;
  const hash = (first.error.details as { args_hash?: string } | undefined)?.args_hash;
  if (!hash) throw new Error("elicit_required with no args_hash");
  const token = issueElicitToken(h.ctx.db, {
    vaultId: h.ctx.vaultId,
    toolName: name,
    argsHash: hash,
    caller: h.ctx.caller,
  });
  return h.runtime.registry.dispatch(name, input, { ...h.ctx, elicitToken: token });
}

function plant(vaultDir: string, rel: string, content: string): void {
  const abs = join(vaultDir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

// ---------------------------------------------------------------------------------------------

describe("memoryDefense block mode — remaining writers, real wiring, nothing persisted", () => {
  it("bulk_create_notes refuses secret-shaped content and writes nothing", async () => {
    await withHarness("block", async (h) => {
      const secret = fakeOpenAiKey();
      const r = await confirmed(h, "bulk_create_notes", {
        vault: "main",
        items: [{ path: "probe/bulk-create.md", content: secret }],
      });
      const out = un<{ results: Array<{ ok: boolean; error?: { code: string } }> }>(r);
      expect(out.results[0]?.ok).toBe(false);
      expect(out.results[0]?.error?.code).toBe("secret_detected");
      expect(existsSync(join(h.vaultDir, "probe/bulk-create.md"))).toBe(false);
      expect(JSON.stringify(r)).not.toContain(secret);
    });
  });

  // Review finding: `runBulk`'s shared `identity(item)` spread onto a failed result (vault/
  // bulk.ts) echoed the raw identity fields even when the refusal WAS the identity field itself —
  // here the PATH (not the content) is what's secret-shaped, so refusePathIfSecretShaped throws
  // before any content scan, and the pre-fix `{ path: item.path, ok: false, error }` spread put
  // the raw secret-shaped path right back in the same failed item.
  it("bulk_create_notes refuses a secret-shaped PATH and does not echo it in results", async () => {
    await withHarness("block", async (h) => {
      const secret = fakeOpenAiKey();
      const r = await confirmed(h, "bulk_create_notes", {
        vault: "main",
        items: [{ path: `probe/${secret}.md`, content: "clean content" }],
      });
      const out = un<{ results: Array<{ ok: boolean; error?: { code: string } }> }>(r);
      expect(out.results[0]?.ok).toBe(false);
      expect(out.results[0]?.error?.code).toBe("secret_detected");
      expect(JSON.stringify(r)).not.toContain(secret);
    });
  });

  it("bulk_set_property refuses a secret-shaped value and leaves the note unchanged", async () => {
    await withHarness("block", async (h) => {
      plant(h.vaultDir, "probe/bulk-set.md", "clean content\n");
      const secret = fakeOpenAiKey();
      const r = await confirmed(h, "bulk_set_property", {
        vault: "main",
        paths: ["probe/bulk-set.md"],
        key: "note",
        value: secret,
      });
      const out = un<{ results: Array<{ ok: boolean; error?: { code: string } }> }>(r);
      expect(out.results[0]?.ok).toBe(false);
      expect(out.results[0]?.error?.code).toBe("secret_detected");
      expect(readFileSync(join(h.vaultDir, "probe/bulk-set.md"), "utf8")).toBe("clean content\n");
      expect(JSON.stringify(r)).not.toContain(secret);
    });
  });

  it("bulk_move_notes refuses a secret-shaped destination and moves nothing", async () => {
    await withHarness("block", async (h) => {
      plant(h.vaultDir, "probe/move-src.md", "clean content\n");
      const secret = fakeOpenAiKey();
      const secretPath = `probe/${secret}.md`;
      const r = await confirmed(h, "bulk_move_notes", {
        vault: "main",
        moves: [{ from: "probe/move-src.md", to: secretPath }],
        dry_run: false,
        update_backlinks: false,
      });
      const out = un<{ results: Array<{ ok: boolean; error?: { code: string } }> }>(r);
      expect(out.results[0]?.ok).toBe(false);
      expect(out.results[0]?.error?.code).toBe("secret_detected");
      expect(existsSync(join(h.vaultDir, "probe/move-src.md"))).toBe(true);
      expect(existsSync(join(h.vaultDir, secretPath))).toBe(false);
      // Review finding: the refused row's own `to` (and `from`) must not echo the
      // secret-shaped destination back in the response.
      expect(JSON.stringify(r)).not.toContain(secret);
    });
  });

  it("restore_note refuses a secret-shaped snapshot and leaves the current note unchanged", async () => {
    await withHarness("block", async (h) => {
      // Plant the secret DIRECTLY on disk (node:fs, no memoryDefense scan at write time) — the
      // scenario this closes is a snapshot capturing content that predates the guard.
      const secret = fakeOpenAiKey();
      plant(h.vaultDir, "probe/restore.md", secret);
      const snap = un<{ snapshot_id: number }>(
        await h.runtime.registry.dispatch(
          "snapshot_note",
          { vault: "main", path: "probe/restore.md" },
          h.ctx,
        ),
      );
      // Current note is now clean — restoring the secret-shaped snapshot is what must be refused.
      plant(h.vaultDir, "probe/restore.md", "clean content\n");
      const r = await confirmed(h, "restore_note", {
        vault: "main",
        path: "probe/restore.md",
        snapshot_id: snap.snapshot_id,
      });
      expect(errOf(r).code).toBe("secret_detected");
      expect(readFileSync(join(h.vaultDir, "probe/restore.md"), "utf8")).toBe("clean content\n");
      expect(JSON.stringify(r)).not.toContain(secret);
    });
  });

  it("update_task refuses a secret-shaped set.description and leaves the task line unchanged", async () => {
    await withHarness("block", async (h) => {
      const original = "- [ ] wiring probe task\n";
      plant(h.vaultDir, "probe/tasks.md", original);
      const secret = fakeOpenAiKey();
      const r = await h.runtime.registry.dispatch(
        "update_task",
        { vault: "main", path: "probe/tasks.md", line: 1, set: { description: secret } },
        h.ctx,
      );
      expect(errOf(r).code).toBe("secret_detected");
      expect(readFileSync(join(h.vaultDir, "probe/tasks.md"), "utf8")).toBe(original);
      expect(JSON.stringify(r)).not.toContain(secret);
    });
  });

  it("update_task (redact mode) persists [REDACTED] and never echoes the raw secret in new_state", async () => {
    await withHarness("redact", async (h) => {
      const original = "- [ ] wiring probe task\n";
      plant(h.vaultDir, "probe/tasks-redact.md", original);
      const secret = fakeOpenAiKey();
      const r = await h.runtime.registry.dispatch(
        "update_task",
        { vault: "main", path: "probe/tasks-redact.md", line: 1, set: { description: secret } },
        h.ctx,
      );
      const out = un<{
        new_state: { description?: string | null };
        content_hash: string;
        redactions?: number;
      }>(r);
      expect(out.redactions ?? 0).toBeGreaterThan(0);
      // Review finding: `new_state` used to be built from the pre-scan object, echoing the raw
      // secret in the same response that redacted it on disk, with a content_hash that didn't
      // even match what `new_state` claimed.
      expect(JSON.stringify(out.new_state)).not.toContain(secret);
      const onDisk = readFileSync(join(h.vaultDir, "probe/tasks-redact.md"), "utf8");
      expect(onDisk).toContain("[REDACTED]");
      expect(onDisk).not.toContain(secret);
      expect(JSON.stringify(r)).not.toContain(secret);
    });
  });

  it("insert_table_row refuses a secret-shaped cell and leaves the table unchanged", async () => {
    await withHarness("block", async (h) => {
      const original =
        "# Data\n\n| Name | Age |\n|---|--:|\n| bob | 3 |\n| ann | 10 |\n\ntrailing\n";
      plant(h.vaultDir, "probe/table.md", original);
      const secret = fakeOpenAiKey();
      const r = await h.runtime.registry.dispatch(
        "insert_table_row",
        { vault: "main", path: "probe/table.md", table_index: 0, values: ["cy", secret] },
        h.ctx,
      );
      expect(errOf(r).code).toBe("secret_detected");
      expect(readFileSync(join(h.vaultDir, "probe/table.md"), "utf8")).toBe(original);
      expect(JSON.stringify(r)).not.toContain(secret);
    });
  });

  it("create_periodic_note refuses a secret-shaped template and creates nothing", async () => {
    await withHarness("block", async (h) => {
      const secret = fakeOpenAiKey();
      plant(h.vaultDir, "templates/secret-template.md", secret);
      const r = await h.runtime.registry.dispatch(
        "create_periodic_note",
        {
          vault: "main",
          period: "daily",
          date: "2026-06-18",
          template_override: "templates/secret-template.md",
        },
        h.ctx,
      );
      expect(errOf(r).code).toBe("secret_detected");
      expect(existsSync(join(h.vaultDir, "2026-06-18.md"))).toBe(false);
      expect(JSON.stringify(r)).not.toContain(secret);
      // Proves nothing persisted from the refused attempt: a clean retry still sees "created".
      const follow = un<{ created: boolean }>(
        await h.runtime.registry.dispatch(
          "find_or_create_periodic_note",
          { vault: "main", period: "daily", date: "2026-06-18" },
          h.ctx,
        ),
      );
      expect(follow.created).toBe(true);
    });
  });

  it("append_to_periodic_note refuses secret-shaped content and creates nothing", async () => {
    await withHarness("block", async (h) => {
      const secret = fakeOpenAiKey();
      const r = await h.runtime.registry.dispatch(
        "append_to_periodic_note",
        { vault: "main", period: "daily", date: "2026-06-18", content: secret },
        h.ctx,
      );
      expect(errOf(r).code).toBe("secret_detected");
      expect(existsSync(join(h.vaultDir, "2026-06-18.md"))).toBe(false);
      expect(JSON.stringify(r)).not.toContain(secret);
      const follow = un<{ created: boolean }>(
        await h.runtime.registry.dispatch(
          "find_or_create_periodic_note",
          { vault: "main", period: "daily", date: "2026-06-18" },
          h.ctx,
        ),
      );
      expect(follow.created).toBe(true);
    });
  });

  // Deliberately "redact" mode, not "block": in block mode enforceMemoryDefense's own
  // matchedPaths throw already carries correct pattern_ids from the (normalizing) walk before
  // commit_capture's own target_path check ever runs — it can't observe the bug this pins. The
  // bug lived in redact mode's fallback path: target_path is still refused outright (there is no
  // safe redacted PATH), but the pre-fix code re-scanned the RAW (un-normalized) `rel` via a
  // bare `redactSecrets(rel)` call for the thrown error's pattern_ids — which is a different
  // function than the walk's own normalizing `scanLeafString`, so a match found only via NFKC
  // folding rescanned clean and reported `pattern_ids: []`.
  it("commit_capture (redact mode) refuses a target_path that matches only after NFKC normalization, with non-empty pattern_ids", async () => {
    await withHarness("redact", async (h) => {
      const cap = un<{ capture_id: string }>(
        await h.runtime.registry.dispatch(
          "enqueue_capture",
          { vault: "main", content: "clean fixture content" },
          h.ctx,
        ),
      );
      // Raw text does NOT match `\bAKIA[0-9A-Z]{16}\b` (full-width codepoints); only the
      // NFKC-normalized form does — refusePathIfSecretShaped's own residual this fixture pins.
      const target = `probe/${fakeFullWidthAkiaPathSegment()}.md`;
      const r = await h.runtime.registry.dispatch(
        "commit_capture",
        { vault: "main", capture_id: cap.capture_id, target_path: target },
        h.ctx,
      );
      const e = errOf(r);
      expect(e.code).toBe("secret_detected");
      // Review finding: `expect(undefined).not.toEqual([])` PASSES — a missing `pattern_ids`
      // (the pre-fix bug) slipped through this assertion. Require a non-empty array that actually
      // names the pattern this fixture is built to match.
      const patternIds = (e.details as { pattern_ids?: string[] } | undefined)?.pattern_ids;
      expect(Array.isArray(patternIds)).toBe(true);
      expect(patternIds?.length ?? 0).toBeGreaterThan(0);
      expect(patternIds).toContain("aws_access_key_id");
      expect(existsSync(join(h.vaultDir, target))).toBe(false);
      // Capture stays queued, uncommitted.
      const queue = un<{ items: Array<{ capture_id: string; committed_at: number | null }> }>(
        await h.runtime.registry.dispatch(
          "list_capture_queue",
          { vault: "main", committed: false },
          h.ctx,
        ),
      );
      expect(queue.items.map((i) => i.capture_id)).toContain(cap.capture_id);
    });
  });

  // Review finding: rewriteAttachmentReferences wrote every referencing note's REWRITTEN body via
  // a raw writeNoteAtomic — no scan — even though the rewritten link text can itself be
  // secret-shaped (the destination path lands verbatim in the link). move_attachment's inventory
  // exemption ("binary attachment op (path only), no text content") was false for this reason.
  it("move_attachment refuses a referencing note body made secret-shaped by the rewrite, and rewrites nothing", async () => {
    await withHarness("block", async (h) => {
      plant(h.vaultDir, "probe/pic.png", "not a real png, just bytes\n");
      const original = "See [[pic.png]] for details.\n";
      plant(h.vaultDir, "probe/ref1.md", original);
      const secret = fakeOpenAiKey();
      const r = await h.runtime.registry.dispatch(
        "move_attachment",
        {
          vault: "main",
          from: "probe/pic.png",
          to: `probe/${secret}.png`,
          update_references: true,
        },
        h.ctx,
      );
      expect(errOf(r).code).toBe("secret_detected");
      expect(readFileSync(join(h.vaultDir, "probe/ref1.md"), "utf8")).toBe(original);
      expect(JSON.stringify(r)).not.toContain(secret);
    });
  });
});

describe("memoryDefense block mode — reflect's persist primitive (persistGovernedNote)", () => {
  it("refuses secret-shaped content and writes nothing to disk", () => {
    const root = mkdtempSync(join(tmpdir(), "otc-memdef-rw-persist-"));
    try {
      const db = openMemoryDb();
      provisionCacheDb(db);
      const secret = fakeOpenAiKey();
      let threw: unknown;
      try {
        persistGovernedNote(
          db,
          { memoryDefense: { mode: "block", pii: true } },
          {
            vaultId: "main",
            root,
            rel: "probe/reflect.md",
            content: secret,
            op: "reflect_persist",
            createDirs: true,
          },
        );
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeInstanceOf(ObsidianTcError);
      if (threw instanceof ObsidianTcError) expect(threw.code).toBe("secret_detected");
      expect(existsSync(join(root, "probe/reflect.md"))).toBe(false);
    } finally {
      rmTemp(root);
    }
  });
});

// Review finding: the case above calls persistGovernedNote directly with an explicit config —
// it never goes through reflect.ts's own handler, so it can't catch a regression that drops
// `memoryDefense: deps.memoryDefense?.(v.id)` from that call site (memory-defense.ts:248).
// Dispatches "reflect" through a real M7 registry (same mock-roles harness
// reflect-persist-governed.test.ts uses) so the deps -> handler -> persistGovernedNote wiring is
// what is actually under test, not just the primitive.
describe("memoryDefense block mode — reflect dispatched through its own handler (deps wiring)", () => {
  it("refuses a secret-shaped synthesis before persisting, via the real reflect dispatch path", async () => {
    const root = mkdtempSync(join(tmpdir(), "otc-memdef-rw-reflect-dispatch-"));
    try {
      const NOW = 1_700_000_000_000;
      const db = openMemoryDb();
      provisionCacheDb(db);
      const ins = db.prepare(
        "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'main', ?, 0, '[]', ?, ?, 40, ?, ?)",
      );
      ins.run("c1", "notes/topic.md", "the quorble pattern part one", "h1", NOW, NOW);
      ensureChunkFts(db, { now: () => NOW, enrich: false });

      const secret = fakeOpenAiKey();
      const mockRoles: GatewayRoles = {
        extract: async () => ({ text: "{}", model: "mock" }),
        synthesize: async () => ({ text: `the answer is ${secret} [1]`, model: "mock-synth" }),
        judge: async () => ({
          text: JSON.stringify({ verdict: "reconsider", summary: "seen before", categories: [] }),
          model: "mock-judge",
        }),
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
        roles: mockRoles,
        classRouter: true,
        snapshots: { enabled: true, retention: 5 },
        reindex: () => {},
        // The SAME closure/wiring shape buildServerRuntime's composition root passes to every
        // other M-tool registrar in this file's own withHarness — this is the field reflect.ts's
        // handler reads at memory-defense.ts:248.
        memoryDefense: () => ({ mode: "block", pii: true }),
      });
      const ctx = {
        caller: "tester",
        authenticated: true,
        grantedScopes: new Set(["read:notes", "write:notes"]),
        vaultId: "main",
        db,
        now: () => NOW,
      };
      const r = await registry.dispatch(
        "reflect",
        { vault: "main", query: "quorble pattern", persist: true, mode: "synthesis" },
        ctx,
      );
      expect(errOf(r).code).toBe("secret_detected");
      // Fresh root — a successful persist would have created the memory folder.
      expect(existsSync(join(root, "memory"))).toBe(false);
      expect(JSON.stringify(r)).not.toContain(secret);
    } finally {
      rmTemp(root);
    }
  });
});

describe("memoryDefense redact mode — persists the redacted form", () => {
  it("bulk_create_notes persists [REDACTED] on disk, not the raw secret, and reports redactions", async () => {
    await withHarness("redact", async (h) => {
      const secret = fakeOpenAiKey();
      const r = await confirmed(h, "bulk_create_notes", {
        vault: "main",
        items: [{ path: "probe/redact.md", content: secret }],
      });
      const out = un<{ results: Array<{ ok: boolean; redactions?: number }> }>(r);
      expect(out.results[0]?.ok).toBe(true);
      expect(out.results[0]?.redactions ?? 0).toBeGreaterThan(0);
      const onDisk = readFileSync(join(h.vaultDir, "probe/redact.md"), "utf8");
      expect(onDisk).toContain("[REDACTED]");
      expect(onDisk).not.toContain(secret);
    });
  });

  it("move_attachment persists [REDACTED] in the rewritten link, not the raw secret", async () => {
    await withHarness("redact", async (h) => {
      plant(h.vaultDir, "probe/pic.png", "not a real png, just bytes\n");
      plant(h.vaultDir, "probe/ref2.md", "See [[pic.png]] for details.\n");
      const secret = fakeOpenAiKey();
      const r = await h.runtime.registry.dispatch(
        "move_attachment",
        {
          vault: "main",
          from: "probe/pic.png",
          to: `probe/${secret}.png`,
          update_references: true,
        },
        h.ctx,
      );
      // Note: `to` legitimately echoes the caller's own destination path here — the attachment
      // FILE itself is not memoryDefense's business (see the "binary attachment op" reasoning
      // still true for delete_attachment); it is the rewritten NOTE BODY this case pins.
      const out = un<{ references_updated: { notes: number; refs: number } }>(r);
      expect(out.references_updated.notes).toBeGreaterThan(0);
      const onDisk = readFileSync(join(h.vaultDir, "probe/ref2.md"), "utf8");
      expect(onDisk).toContain("[REDACTED]");
      expect(onDisk).not.toContain(secret);
    });
  });
});
