// Domain 10 — Bookmarks. Three tools: list_bookmarks, add_bookmark,
// remove_bookmark. Backed by Obsidian's core bookmarks plugin file,
// .obsidian/bookmarks.json — a { items: [...] } tree where each item is a
// file/folder/search/graph/url/heading/block bookmark or a nested "group" with its
// own items. The config path is accessed through resolveVaultPath + enforcePathAcl
// like any vault file, and edits round-trip through json-config: parse to the raw
// object, mutate only items in place, re-serialize with the file's own indentation,
// so unknown keys and on-disk key order survive. add/remove are deduped/idempotent.
import { err, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "../../formats/json-config";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { resolveVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import type { M3Deps } from "./index";

const BOOKMARKS_PATH = ".obsidian/bookmarks.json";

type Item = Record<string, unknown>;
interface BookmarksDoc {
  items?: Item[];
  [k: string]: unknown;
}

const IDENTITY_KEYS = ["path", "url", "query", "subpath", "title"] as const;

/** Count non-group bookmarks, descending into groups. */
function countLeaves(items: Item[]): number {
  let n = 0;
  for (const it of items) {
    if (it.type === "group" && Array.isArray(it.items)) n += countLeaves(it.items as Item[]);
    else n++;
  }
  return n;
}

/** A candidate item matches `match` when every provided key is strictly equal. */
function matches(it: Item, match: Record<string, unknown>): boolean {
  for (const [k, val] of Object.entries(match)) {
    if (val === undefined) continue;
    if (it[k] !== val) return false;
  }
  return true;
}

/** Two bookmarks are "the same" when type + every defined identity key agree. */
function sameBookmark(a: Item, b: Item): boolean {
  if (a.type !== b.type) return false;
  for (const k of IDENTITY_KEYS) if (b[k] !== undefined && a[k] !== b[k]) return false;
  return true;
}

/** Remove every item (recursively, including the group itself) matching `match`. */
function removeMatching(
  items: Item[],
  match: Record<string, unknown>,
): {
  kept: Item[];
  removed: number;
} {
  let removed = 0;
  const kept: Item[] = [];
  for (const it of items) {
    if (it.type === "group" && Array.isArray(it.items)) {
      const sub = removeMatching(it.items as Item[], match);
      it.items = sub.kept;
      removed += sub.removed;
      if (matches(it, match)) {
        removed++;
        continue;
      }
    } else if (matches(it, match)) {
      removed++;
      continue;
    }
    kept.push(it);
  }
  return { kept, removed };
}

function topGroup(items: Item[], title: string): Item | undefined {
  return items.find((it) => it.type === "group" && it.title === title);
}

const BookmarkItem = z
  .object({
    type: z.enum(["file", "folder", "search", "graph", "url", "group", "heading", "block"]),
    path: z.string().optional(),
    subpath: z.string().optional(),
    url: z.string().optional(),
    query: z.string().optional(),
    title: z.string().optional(),
  })
  .passthrough();

const MatchCriteria = z
  .object({
    type: z.string().optional(),
    path: z.string().optional(),
    subpath: z.string().optional(),
    url: z.string().optional(),
    query: z.string().optional(),
    title: z.string().optional(),
  })
  .strict()
  .refine((m) => Object.values(m).some((v) => v !== undefined), {
    message: "match must specify at least one field",
  });

export function buildBookmarkTools(deps: M3Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "list_bookmarks",
      description:
        "List the vault's bookmarks tree (.obsidian/bookmarks.json), preserving groups and unknown fields.",
      inputSchema: z.object({ vault: VaultId }).strict(),
      requiredScopes: ["read:bookmarks"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        enforcePathAcl(ctx.acl, "read", BOOKMARKS_PATH);
        const abs = resolveVaultPath(v.root, BOOKMARKS_PATH);
        const file = readJsonFile<BookmarksDoc>(abs, { items: [] });
        const items = Array.isArray(file.data.items) ? file.data.items : [];
        return {
          vault: v.id,
          exists: file.exists,
          items,
          count: countLeaves(items),
          content_hash: file.hash,
        };
      },
    }),

    defineTool({
      name: "add_bookmark",
      description:
        "Add a bookmark (optionally into a named group, created if absent). A duplicate is a no-op unless allow_duplicate is set.",
      inputSchema: z
        .object({
          vault: VaultId,
          bookmark: BookmarkItem,
          group: z.string().min(1).optional(),
          allow_duplicate: z.boolean().default(false),
        })
        .strict(),
      requiredScopes: ["write:bookmarks"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        enforcePathAcl(ctx.acl, "write", BOOKMARKS_PATH);
        const abs = resolveVaultPath(v.root, BOOKMARKS_PATH);
        const file = readJsonFile<BookmarksDoc>(abs, { items: [] });
        const data = file.data;
        if (!Array.isArray(data.items)) data.items = [];
        const items = data.items as Item[];

        let target = items;
        if (input.group) {
          let g = topGroup(items, input.group);
          if (!g) {
            g = { type: "group", title: input.group, items: [] };
            items.push(g);
          }
          if (!Array.isArray(g.items)) g.items = [];
          target = g.items as Item[];
        }

        const bm = input.bookmark as Item;
        const duplicate = target.some((it) => sameBookmark(it, bm));
        let added = false;
        if (!duplicate || input.allow_duplicate) {
          target.push(bm);
          added = true;
        }
        const { hash } = writeJsonFile(abs, data, file.indent, file.trailingNewline);
        return {
          vault: v.id,
          added,
          duplicate,
          group: input.group ?? null,
          count: countLeaves(items),
          content_hash: hash,
        };
      },
    }),

    defineTool({
      name: "remove_bookmark",
      description:
        "Remove every bookmark matching the criteria (recursively, or within a named group). Returns the number removed.",
      inputSchema: z
        .object({
          vault: VaultId,
          match: MatchCriteria,
          group: z.string().min(1).optional(),
        })
        .strict(),
      requiredScopes: ["delete:bookmarks"],
      // Deletes every match recursively (a whole group + its children), so it requires a
      // HITL elicit token like delete_note / delete_attachment.
      destructive: true,
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        enforcePathAcl(ctx.acl, "delete", BOOKMARKS_PATH);
        const abs = resolveVaultPath(v.root, BOOKMARKS_PATH);
        const file = readJsonFile<BookmarksDoc>(abs, { items: [] });
        const data = file.data;
        const items = Array.isArray(data.items) ? (data.items as Item[]) : [];

        let removed = 0;
        if (input.group) {
          const g = topGroup(items, input.group);
          if (!g) throw err.invalidInput("group not found", { group: input.group });
          const sub = removeMatching((g.items as Item[]) ?? [], input.match);
          g.items = sub.kept;
          removed = sub.removed;
        } else {
          const r = removeMatching(items, input.match);
          data.items = r.kept;
          removed = r.removed;
        }
        const { hash } = writeJsonFile(abs, data, file.indent, file.trailingNewline);
        return {
          vault: v.id,
          removed,
          count: countLeaves(Array.isArray(data.items) ? (data.items as Item[]) : []),
          content_hash: hash,
        };
      },
    }),
  ];
}
