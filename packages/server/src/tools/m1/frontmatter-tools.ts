// Domain 3 — Frontmatter / properties (G2.1 r2). Five tools over a note's YAML
// frontmatter: read_frontmatter, read_property, update_frontmatter, list_properties,
// find_notes_by_property. Reads go through parseNote (body bytes preserved verbatim);
// writes re-emit via serializeNote and are content-addressed (prev_hash CAS ->
// concurrent_modification). update_frontmatter's `replace` operation discards all
// existing metadata, so it gates on confirmation via requireConfirmation; set/remove/
// merge do not. Property keys are top-level (nested traversal is a later enhancement).
import { err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { type FolderAcl, globMatch } from "../../acl";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import type { Frontmatter } from "../../vault/frontmatter";
import { parseNote, serializeNote } from "../../vault/frontmatter";
import { requireConfirmation } from "../../vault/hitl";
import { noteExists, readNote, writeNoteAtomic } from "../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import { defineTool } from "./define";
import type { M1Deps } from "./index";

// ── helpers ──────────────────────────────────────────────────────────────────

function readable(acl: FolderAcl | undefined, rel: string): boolean {
  if (!acl) return true;
  const list = acl.readPaths;
  if (list === undefined) return true;
  return list.some((g) => globMatch(g, rel));
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Loose JSON value match: equal scalars/objects, or membership when the stored
 *  value is an array (so `find_notes_by_property tag=foo` matches `tags: [foo]`). */
function valueMatches(stored: unknown, query: unknown): boolean {
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (Array.isArray(stored)) return stored.some((e) => eq(e, query)) || eq(stored, query);
  return eq(stored, query);
}

// ── schemas ──────────────────────────────────────────────────────────────────

const UpdateInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    operation: z.enum(["set", "remove", "merge", "replace"]),
    key: z.string().min(1).optional(),
    value: z.unknown().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
    prev_hash: z.string().optional(),
    create_if_missing: z.boolean().default(false),
  })
  .strict();

const FindInput = z
  .object({
    vault: VaultId,
    key: z.string().min(1),
    value: z.unknown().optional(),
    folder: VaultPath.optional(),
    limit: z.number().int().positive().max(1000).default(200),
    // THE-251: terse drops the matched value, returning path only.
    verbosity: z.enum(["full", "terse"]).default("full"),
  })
  .strict();

const ListPropsInput = z
  .object({
    vault: VaultId,
    folder: VaultPath.optional(),
    max_notes: z.number().int().positive().max(50000).default(5000),
  })
  .strict();

// ── tools ────────────────────────────────────────────────────────────────────

export function buildFrontmatterTools(deps: M1Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "read_frontmatter",
      description: "Read a note's parsed YAML frontmatter (null when the note has none).",
      inputSchema: z.object({ vault: VaultId, path: VaultPath }).strict(),
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "read", rel, v.root);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("note not found", { path: rel });
        const { raw, hash } = readNote(abs);
        const parsed = parseNote(raw);
        return {
          vault: v.id,
          path: rel,
          frontmatter: parsed.frontmatter,
          has_frontmatter: parsed.hasFrontmatter,
          content_hash: hash,
        };
      },
    }),

    defineTool({
      name: "read_property",
      description: "Read a single top-level frontmatter property from a note.",
      inputSchema: z.object({ vault: VaultId, path: VaultPath, key: z.string().min(1) }).strict(),
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "read", rel, v.root);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("note not found", { path: rel });
        const fm = parseNote(readNote(abs).raw).frontmatter ?? {};
        const found = Object.hasOwn(fm, input.key);
        return {
          vault: v.id,
          path: rel,
          key: input.key,
          value: found ? fm[input.key] : null,
          found,
        };
      },
    }),

    defineTool({
      name: "update_frontmatter",
      description:
        "Mutate a note's frontmatter (set/remove/merge/replace). `replace` discards all existing metadata and requires confirmation. Optional prev_hash gives compare-and-swap.",
      inputSchema: UpdateInput,
      requiredScopes: ["write:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "write", rel, v.root);

        const ex = noteExists(abs);
        let body = "";
        let fm: Frontmatter = {};
        let rawFm: string | null = null;
        let prevHash: string | null = null;
        if (ex.exists) {
          if (ex.type === "folder") throw err.invalidInput("path is a folder", { path: rel });
          const cur = readNote(abs);
          prevHash = cur.hash;
          if (input.prev_hash !== undefined && input.prev_hash !== cur.hash)
            throw err.concurrentModification("note changed since prev_hash", {
              path: rel,
              expected: input.prev_hash,
              actual: cur.hash,
            });
          const parsed = parseNote(cur.raw);
          fm = { ...(parsed.frontmatter ?? {}) };
          body = parsed.body;
          rawFm = parsed.rawFrontmatter;
        } else if (!input.create_if_missing) {
          throw err.noteNotFound("note not found; set create_if_missing to create it", {
            path: rel,
          });
        }

        let next: Frontmatter;
        switch (input.operation) {
          case "set": {
            if (!input.key) throw err.invalidInput("key is required for set");
            // Branch on presence so an explicit null is stored as null, while an omitted
            // value is a clear error rather than a silent null write (F5).
            if (!("value" in input))
              throw err.invalidInput(
                "value is required for set (use null explicitly to store null)",
                { key: input.key },
              );
            next = { ...fm, [input.key]: input.value };
            break;
          }
          case "remove": {
            if (!input.key) throw err.invalidInput("key is required for remove");
            next = { ...fm };
            delete next[input.key];
            break;
          }
          case "merge": {
            if (!input.properties) throw err.invalidInput("properties is required for merge");
            next = { ...fm, ...input.properties };
            break;
          }
          default: {
            if (!input.properties) throw err.invalidInput("properties is required for replace");
            next = { ...input.properties };
            break;
          }
        }

        requireConfirmation(ctx, "update_frontmatter", input, input.operation === "replace", {
          path: rel,
          operation: input.operation,
        });

        const hasKeys = Object.keys(next).length > 0;
        const content = serializeNote(hasKeys ? next : null, body, rawFm);
        writeNoteAtomic(abs, content, true);
        deps.reindex?.(v.id, rel, content);
        return {
          vault: v.id,
          path: rel,
          operation: input.operation,
          created: !ex.exists,
          frontmatter: hasKeys ? next : null,
          content_hash: contentHash(content),
          prev_hash: prevHash,
        };
      },
    }),

    defineTool({
      name: "list_properties",
      description:
        "Aggregate frontmatter property keys across notes, with usage counts and value types.",
      inputSchema: ListPropsInput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = input.folder ? normalizeVaultPath(input.folder) : undefined;
        const entries = walkVault(v.root, { sub, extensions: [".md"] }).filter((e) =>
          readable(ctx.acl, e.relPath),
        );
        const stats = new Map<string, { count: number; types: Set<string> }>();
        let scanned = 0;
        for (const e of entries) {
          if (scanned >= input.max_notes) break;
          scanned++;
          const fm = parseNote(readNote(resolveVaultPath(v.root, e.relPath)).raw).frontmatter;
          if (!fm) continue;
          for (const [k, val] of Object.entries(fm)) {
            const s = stats.get(k) ?? { count: 0, types: new Set<string>() };
            s.count++;
            s.types.add(typeOf(val));
            stats.set(k, s);
          }
        }
        const properties = [...stats.entries()]
          .map(([key, s]) => ({ key, count: s.count, types: [...s.types].sort() }))
          .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
        return { vault: v.id, notes_scanned: scanned, properties };
      },
    }),

    defineTool({
      name: "find_notes_by_property",
      description:
        "Find notes whose frontmatter has a key (optionally equal to a value, or containing it when the value is a list). Set verbosity=terse to return path only (dropping the matched value).",
      inputSchema: FindInput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = input.folder ? normalizeVaultPath(input.folder) : undefined;
        const entries = walkVault(v.root, { sub, extensions: [".md"] }).filter((e) =>
          readable(ctx.acl, e.relPath),
        );
        const matches: Array<{ path: string; value: unknown }> = [];
        let truncated = false;
        for (const e of entries) {
          const fm = parseNote(readNote(resolveVaultPath(v.root, e.relPath)).raw).frontmatter;
          if (!fm || !Object.hasOwn(fm, input.key)) continue;
          const stored = fm[input.key];
          if (input.value !== undefined && !valueMatches(stored, input.value)) continue;
          if (matches.length >= input.limit) {
            truncated = true;
            break;
          }
          matches.push({ path: e.relPath, value: stored });
        }
        return {
          vault: v.id,
          key: input.key,
          total: matches.length,
          truncated,
          matches: input.verbosity === "terse" ? matches.map((m) => ({ path: m.path })) : matches,
        };
      },
    }),
  ];
}
