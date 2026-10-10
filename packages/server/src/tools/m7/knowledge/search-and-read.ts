// search_and_read: search, then return the top-k FULL notes (or the matched sections) in one call,
// instead of a search that returns chunks followed by a read_notes call that fetches the bodies.
//
// Nothing here is a second implementation:
//   - ranking, filters and the query cache are vault_graph_search's (searchOneVault), run under the
//     vault's own ACL, so a note the caller cannot read is never a candidate;
//   - each note is read by read_notes' path (readVaultNote), and a section by patch_note/read_note's
//     resolver (resolveSection);
//   - the byte budget, next_cursor and per-item too_large are byte-page.ts's paginateByBytes.
//
// ACL is enforced per item on EVERY page inside `produce`, under aclFor(vault) ?? ctx.acl, with the
// caller's granted scopes so rule-scopes apply. No central `pathAcl` is declared: the paths are
// found by the search, not named by the caller, so there is nothing for the central stage to
// extract. A denial that still happens (permission revoked between two pages) is an ITEM, reported
// as `note_not_found` with no path, so it cannot be told from a missing note; `deniedItems` hands
// the real code back to dispatch so it is audited like read_notes' thrown acl_denied.
//
// BUDGET POLICY. The selected notes share the response budget equally (`max_bytes_per_item`
// overrides the share). A note larger than its share is CUT, on a character boundary, and marked
// `truncated: true` with `size_bytes` (its untruncated body size): a truncated note beats a
// `too_large` error that returns nothing, and it keeps all k notes on one page. `too_large` remains
// for what a cut cannot fix (an entry whose frontmatter alone exceeds the budget). A caller who
// raises `max_bytes_per_item` past the share gets pages instead, via next_cursor.
//
// PAGES. The search runs once per walk. Its selection is kept (bounded, TTL = the cursor's) so a
// later page reads the SAME items in the SAME order and re-checks ACL on each; a page that finds
// no kept selection (expired, evicted, restart) searches again.
import { ObsidianTcError, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { Database } from "../../../db/types";
import { argsHash } from "../../../hash";
import { paginateByBytes, pagingOf } from "../../../mcp/byte-page";
import type { ToolDefinition } from "../../../mcp/registry";
import type { VaultAclResolver } from "../../../mcp/resources";
import type { GraphSearchResult } from "../../../search/graph_search";
import { normalizeVaultPath } from "../../../vault/paths";
import { defineTool } from "../../m1/define";
import { resolveSection } from "../../m1/notes/anchors";
import { readVaultNote } from "../../m1/notes/read";
import { ResponseFormatInput, resolveResponseFormat } from "../../response-format";
import type { M7Deps } from "./deps";
import { searchOneVault } from "./graph-search";
import { cacheContextFor, type RetrievalRuntime } from "./retrieval-runtime";
import { SearchAndReadOutput } from "./search-and-read-schemas";

type Note = z.infer<typeof SearchAndReadOutput>["notes"][number];
type ErrorItem = z.infer<typeof SearchAndReadOutput>["errors"][number];
type Entry = { kind: "note"; note: Note } | { kind: "error"; error: ErrorItem; denied?: string };

/** One selected search hit: a whole note (mode "note") or one section of it (mode "section"). */
interface Item {
  path: string;
  rank: number;
  score: number;
  chunkId: string;
  /** Section mode. undefined = the chunk row is gone; null = the chunk sits before any heading. */
  heading?: string | null;
  content?: string;
}

const MAX_K = 20;
/** Search over-fetches chunks: several chunks of one note collapse into one item. */
const POOL_FACTOR = 4;
const MAX_POOL = 100;
/** Held back from the per-item cap for the envelope and a cursor. */
const ENVELOPE_RESERVE = 1024;
const MIN_ITEM_BYTES = 512;
/** Same lifetime as a continuation cursor (byte-page.ts). */
const SELECTION_TTL_MS = 600_000;
const SELECTION_MAX = 64;

/** How many chunks the search is asked for, so k distinct notes can be selected from them. */
export function candidatePoolSize(k: number): number {
  return Math.min(MAX_POOL, k * POOL_FACTOR);
}

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? "null", "utf8");
const jsonTextBytes = (s: string): number => bytes(s) - 2;

/** The longest prefix of `text` whose JSON string form fits `room` bytes, never splitting a
 *  surrogate pair. */
function clip(text: string, room: number): string {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (jsonTextBytes(text.slice(0, mid)) <= room) lo = mid;
    else hi = mid - 1;
  }
  const last = text.charCodeAt(lo - 1);
  if (lo > 0 && last >= 0xd800 && last <= 0xdbff) lo--;
  return text.slice(0, lo);
}

/** `note` cut so its serialized entry is at most `cap` bytes; unchanged when it already is. */
function cutToCap(note: Note, cap: number): Note {
  if (bytes(note) <= cap) return note;
  const cut = { ...note, body: "", truncated: true };
  return { ...cut, body: clip(note.body, cap - bytes(cut)) };
}

/** GH #1027: the concise form of a (possibly cut) note: an untruncated item drops size_bytes and
 *  truncated, and a resolved section drops section_resolved (absent means it resolved). A truncated
 *  item keeps size_bytes, the full size it would take to fetch whole. */
function conciseNote(note: Note): Note {
  const { size_bytes, truncated, section_resolved, ...rest } = note;
  return {
    ...rest,
    ...(section_resolved === false ? { section_resolved } : {}),
    ...(truncated === true ? { truncated, size_bytes } : {}),
  };
}

function chunkHeadings(db: Database, vaultId: string, chunkIds: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (chunkIds.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT id, headings FROM chunks WHERE vault_id = ? AND id IN (${chunkIds.map(() => "?").join(",")})`,
    )
    .all(vaultId, ...chunkIds) as Array<{ id: string; headings: string }>;
  for (const r of rows) {
    try {
      const parsed: unknown = JSON.parse(r.headings);
      if (Array.isArray(parsed))
        out.set(
          r.id,
          parsed.filter((h) => typeof h === "string"),
        );
    } catch {
      // A malformed breadcrumb leaves the chunk without a heading: its section is unresolved.
    }
  }
  return out;
}

/** The first k distinct notes (or sections) in search order. */
function select(
  results: GraphSearchResult[],
  mode: "note" | "section",
  k: number,
  db: Database,
  vaultId: string,
): Item[] {
  const headings =
    mode === "section"
      ? chunkHeadings(
          db,
          vaultId,
          results.map((r) => r.chunk_id),
        )
      : new Map<string, string[]>();
  const seen = new Set<string>();
  const items: Item[] = [];
  for (const r of results) {
    const crumb = headings.get(r.chunk_id);
    const heading = crumb === undefined ? undefined : (crumb[crumb.length - 1] ?? null);
    const key =
      mode === "note"
        ? r.path
        : `${r.path}\u0000${heading === undefined ? `chunk:${r.chunk_id}` : (heading ?? "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      path: r.path,
      rank: items.length + 1,
      score: r.rerank_score,
      chunkId: r.chunk_id,
      ...(mode === "section" ? { heading } : {}),
      ...(r.content !== undefined ? { content: r.content } : {}),
    });
    if (items.length === k) break;
  }
  return items;
}

/** Text of the section `heading` names in `body` (null = the preamble before the first heading),
 *  or null when it is not one unique section. */
function sectionText(body: string, heading: string | null): string | null {
  const r = resolveSection(
    body,
    heading === null ? { type: "frontmatter" } : { type: "heading", heading },
  );
  if (!r.found) return null;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  return body.split(/\r?\n/).slice(r.startIndex, r.endIndex).join(eol);
}

const DENIAL_CODES = new Set(["acl_denied", "forbidden"]);

function frame(mode: "note" | "section", vault: string, entries: Entry[], next: string | null) {
  const notes: Note[] = [];
  const errors: ErrorItem[] = [];
  for (const e of entries) {
    if (e.kind === "note") notes.push(e.note);
    else errors.push(e.error);
  }
  return { vault, mode, notes, errors, next_cursor: next };
}

export function createSearchAndReadTool(
  deps: M7Deps,
  retrieval: RetrievalRuntime,
  aclFor: VaultAclResolver,
): ToolDefinition {
  // Denial codes of the items a RESULT carries, read back by `deniedItems` (the output must not
  // carry them: a denied item is reported as missing).
  const denials = new WeakMap<object, string[]>();
  const selections = new Map<string, { at: number; items: Item[] }>();

  const remember = (key: string, items: Item[]): void => {
    const now = Date.now();
    for (const [k, s] of selections) if (now - s.at > SELECTION_TTL_MS) selections.delete(k);
    selections.set(key, { at: now, items });
    while (selections.size > SELECTION_MAX)
      selections.delete(selections.keys().next().value as string);
  };

  return defineTool({
    name: "search_and_read",
    wholeNotes: true,
    domain: "search",
    description:
      "Search a vault and return the top-k full notes in one call, instead of a search followed by read_notes. Ranking is vault_graph_search's, limited to notes you can read. mode=note (default) returns each note's frontmatter and body; mode=section returns the heading section each hit matched. k is at most 20. The result is held under the server's byte budget, shared equally across the notes: a note over its share is cut and marked truncated: true with size_bytes (its full size); fetch it whole with read_note. Anything that still does not fit comes back with next_cursor: repeat the same call plus cursor until it is null. An item that cannot be returned is a per-item error with its rank (a missing note and an unreadable one look the same). A cursor is bound to the caller, the tool and these exact arguments, and expires. response_format=concise returns {path, rank, score, body, content_hash} per note without frontmatter (note mode) or chunk_id (section mode); size_bytes and truncated appear only on a truncated item, and section_resolved only when false.",
    inputSchema: z
      .object({
        vault: VaultId,
        query: z.string().min(1),
        k: z.number().int().min(1).max(MAX_K).default(5),
        mode: z.enum(["note", "section"]).default("note"),
        max_bytes_per_item: z
          .number()
          .int()
          .min(MIN_ITEM_BYTES)
          .optional()
          .describe(
            "Cap on one returned item's serialized bytes. Default: an equal share of the response budget.",
          ),
        cursor: z
          .string()
          .min(1)
          .max(4096)
          .optional()
          .describe("The next_cursor of a previous page of this same request."),
        ...ResponseFormatInput,
      })
      .strict(),
    outputSchema: SearchAndReadOutput,
    requiredScopes: ["read:notes"],
    tags: ["knowledge", "search", "external-network"],
    deniedItems: (out) => denials.get(out) ?? [],
    handler: async (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      // The vault's own ACL, not blindly the caller's root one (see the header).
      const acl = aclFor(v.id) ?? ctx.acl;
      const paging = pagingOf(deps.paging);

      const selectionKey = argsHash("search_and_read.selection", {
        principal: ctx.caller ?? null,
        vault: v.id,
        query: input.query,
        k: input.k,
        mode: input.mode,
      });
      let items = input.cursor !== undefined ? selections.get(selectionKey)?.items : undefined;
      if (items === undefined) {
        const leg = await searchOneVault(
          deps,
          retrieval,
          ctx,
          v.id,
          acl,
          { text: input.query, finalTopK: candidatePoolSize(input.k) },
          input.query,
          [input.query],
          cacheContextFor(deps, ctx, v.id, input.query, acl),
          "search_and_read",
        );
        items = select(leg.results, input.mode, input.k, ctx.db, v.id);
        remember(selectionKey, items);
      }

      const concise = resolveResponseFormat(input, deps.responseFormat) === "concise";
      const budget = paging.budgetBytes();
      const share = Math.floor((budget - ENVELOPE_RESERVE) / Math.max(1, items.length));
      const cap = Math.max(
        MIN_ITEM_BYTES,
        Math.min(budget - ENVELOPE_RESERVE, input.max_bytes_per_item ?? share),
      );
      const missing = (item: Item, code: string, message: string, denied?: string): Entry => ({
        kind: "error",
        error: { rank: item.rank, code, message },
        ...(denied !== undefined ? { denied } : {}),
      });

      const { entries, nextCursor } = await paginateByBytes<Item, Entry>({
        paging,
        binding: { tool: "search_and_read", principal: ctx.caller, args: input },
        cursor: input.cursor,
        items,
        // Runs per item on every page, so a permission revoked between pages is honoured on resume.
        produce: (item) => {
          try {
            const rel = normalizeVaultPath(item.path);
            const { hash, parsed } = readVaultNote(v.root, rel, acl, ctx.grantedScopes);
            const base = { path: rel, rank: item.rank, score: item.score, content_hash: hash };
            let note: Note;
            if (input.mode === "note") {
              note = {
                ...base,
                ...(concise ? {} : { frontmatter: parsed.frontmatter }),
                body: parsed.body,
                size_bytes: Buffer.byteLength(parsed.body, "utf8"),
                truncated: false,
              };
            } else {
              const sec =
                item.heading === undefined ? null : sectionText(parsed.body, item.heading);
              // An unresolvable section (edited since indexing, duplicate heading) falls back to the
              // matched chunk itself, then to the whole body: something readable, flagged.
              const body = sec ?? item.content ?? parsed.body;
              note = {
                ...base,
                ...(concise ? {} : { chunk_id: item.chunkId }),
                heading: item.heading ?? null,
                section_resolved: sec !== null,
                body,
                size_bytes: Buffer.byteLength(body, "utf8"),
                truncated: false,
              };
            }
            const cut = cutToCap(note, cap);
            return { kind: "note", note: concise ? conciseNote(cut) : cut };
          } catch (e) {
            const code = e instanceof ObsidianTcError ? e.code : "internal_error";
            // Denied and missing are one answer: neither names the path.
            if (DENIAL_CODES.has(code) || code === "note_not_found")
              return missing(
                item,
                "note_not_found",
                "note not found",
                DENIAL_CODES.has(code) ? code : undefined,
              );
            return missing(
              item,
              code,
              e instanceof ObsidianTcError ? e.message : "could not read note",
            );
          }
        },
        tooLarge: (item, { size, budget: b }) => ({
          kind: "error",
          error: {
            rank: item.rank,
            path: item.path,
            code: "too_large",
            message:
              "note is larger than the response byte budget even when cut, and cannot be returned",
            size,
            budget: b,
          },
        }),
        frame: (es, next) => frame(input.mode, v.id, es, next),
        lane: (e) => e.kind,
        wire: (e) => (e.kind === "note" ? e.note : e.error),
      });

      const result = frame(input.mode, v.id, entries, nextCursor);
      denials.set(
        result,
        entries.flatMap((e) => (e.kind === "error" && e.denied !== undefined ? [e.denied] : [])),
      );
      return result;
    },
  });
}
