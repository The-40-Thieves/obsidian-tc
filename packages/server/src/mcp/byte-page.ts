// Byte-budgeted continuation paginator: "an ordered list of item producers + a byte budget".
// (util/paginate.ts is a different, unrelated helper: unsigned count-limit offset paging.)
//
// WHY. A bulk read used to fail the WHOLE call with `overflow` the moment its serialized result
// crossed the governor's byte budget (registry/result-governance.ts). paginateByBytes() instead returns
// the entries that fit plus an opaque `next_cursor`; calling again with the same arguments and that
// cursor resumes exactly where the page stopped (no duplicate, no gap, request order preserved).
//
// HOW A TOOL USES IT (read_notes, tools/m1/notes/read.ts, is the reference consumer; batch
// resources/read and search_and_read are meant to reuse this unchanged):
//
//   1. Input schema gains `cursor: z.string().optional()`; output gains `next_cursor: string|null`.
//   2. In the handler, resolve `const paging = pagingOf(deps.paging)` and call
//        const { entries, nextCursor } = await paginateByBytes({
//          paging,                                   // codec + byte budget
//          binding: { tool, principal: ctx.caller, args: input },   // `cursor` is ignored in args
//          cursor: input.cursor,
//          items: input.paths,                       // the ordered request items
//          produce: (item) => entry,                 // runs per item, on EVERY page (see below)
//          tooLarge: (item, { size, budget }) => errorEntry,
//          frame: (entries, nextCursor) => result,   // the tool's whole result object
//          lane: (entry) => "notes" | "errors",      // which array of `frame` the entry lands in
//          wire: (entry) => payload,                 // optional: what the array actually holds
//        });
//        return frame(entries, nextCursor);
//   3. `produce` does the per-item work AND the per-item gates (folder ACL, memory defence, ...).
//      Because it runs for each item on each page, a permission revoked between two pages is
//      honoured on the resume. It must turn a per-item failure into an error ENTRY, not throw:
//      a throw aborts the whole page.
//
// BYTE ACCOUNTING IS EXACT, not estimated. The page is sized against the same JSON.stringify the
// governor measures: `frame([], null)` gives the fixed envelope, each entry adds its own bytes, and
// every entry after the first in a lane adds one comma. The contract this needs from `frame`: each
// entry appears exactly once, unmodified, inside one array-valued field named by `lane(entry)`.
// The envelope is reserved with a worst-case cursor whenever more items follow, so a page that
// stops early can always carry its cursor.
//
// PROGRESS. Every page consumes at least one item, so looping on `next_cursor` always terminates.
// An item whose entry cannot fit even alone on a page is replaced by `tooLarge(...)` (which the
// caller shapes as a per-item error carrying `size` and `budget`) and the walk moves on. The
// verdict depends only on the item, never on where the page happened to start.
//
// CURSOR BINDING. The cursor is minted by the same HMAC codec the elicit requestState uses
// (@modelcontextprotocol/server createRequestStateCodec), under its own derived key. It carries
// the tool, a digest of the principal, a hash of the request arguments (`cursor` excluded), and the
// next item index. On resume all three must match the current call, so a cursor cannot be replayed
// by another principal, against another tool, or with different arguments (a different item set).
// Any failure is a structured `invalid_input` with `details.reason`: `expired`, `invalid` (bad
// signature / malformed), `foreign` (other principal or tool) or `request_mismatch` (other args).
import { createHash, randomBytes } from "node:crypto";
import { createRequestStateCodec, type ServerContext } from "@modelcontextprotocol/server";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { argsHash } from "../hash";
import { traceItem } from "../otel/dispatch-spans";

/** Fallback byte budget, matching ToolRegistry's own default maxResponseBytes. */
const DEFAULT_BUDGET_BYTES = 1_000_000;
/** How long a continuation cursor stays valid. Long enough for an agent to work a page, short
 *  enough that a leaked cursor is worthless soon. */
const CURSOR_TTL_SECONDS = 600;

interface CursorPayload {
  v: 1;
  /** Tool the cursor was minted for. */
  t: string;
  /** Digest of the principal - never the raw caller id. */
  p: string;
  /** argsHash of the request arguments with `cursor` removed. */
  h: string;
  /** Index of the first item NOT yet delivered. */
  o: number;
}

export interface PageCursorCodec {
  mint(payload: CursorPayload): Promise<string>;
  verify(state: string): Promise<CursorPayload>;
}

/** What a tool needs to paginate: the signing codec and the live byte budget. */
export interface PagingDeps {
  codec: PageCursorCodec;
  /** The governor's budget (ToolRegistry.maxResponseBytes), read per call so a lowered ceiling applies. */
  budgetBytes: () => number;
}

/** Derive the codec key from `secret`, domain-separated so it differs from the elicit key. */
function derivePageCursorKey(secret: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`${secret}|obsidian-tc/page-cursor`).digest());
}

export function createPageCursorCodec(
  secret: string,
  ttlSeconds = CURSOR_TTL_SECONDS,
): PageCursorCodec {
  const codec = createRequestStateCodec<CursorPayload>({
    key: derivePageCursorKey(secret),
    ttlSeconds,
  });
  return {
    mint: (payload) => codec.mint(payload),
    // `bind` is not configured (binding is done on the payload), so the SDK ignores its ctx.
    verify: (state) => codec.verify(state, undefined as unknown as ServerContext),
  };
}

/** Production wiring: `secret` is auth.jwtSecret when configured, else a per-process random one
 *  (stdio has no secret; a restart then invalidates outstanding cursors, like a TTL would). */
export function createPagingDeps(opts: {
  secret?: string | undefined;
  budgetBytes: () => number;
  ttlSeconds?: number;
}): PagingDeps {
  return {
    codec: createPageCursorCodec(opts.secret || randomBytes(32).toString("hex"), opts.ttlSeconds),
    budgetBytes: opts.budgetBytes,
  };
}

let processDefault: PagingDeps | undefined;
/** `deps.paging` when wired, else a lazily-built per-process default (tests, bare registries). */
export function pagingOf(paging: PagingDeps | undefined): PagingDeps {
  if (paging) return paging;
  processDefault ??= createPagingDeps({ budgetBytes: () => DEFAULT_BUDGET_BYTES });
  return processDefault;
}

export interface PaginateByBytesOptions<K, E> {
  paging: PagingDeps;
  /** What the cursor is bound to. `args` is the request's arguments; a `cursor` key is ignored. */
  binding: { tool: string; principal: string | null; args: unknown };
  /** The `cursor` argument of this call, if it is a resume. */
  cursor: string | undefined;
  /** The full ordered request. Identical on every page of one walk (the args hash enforces it). */
  items: readonly K[];
  /** Per-item work + gates. Runs on every page for the items it reaches. Must not throw for a
   *  per-item failure - return an error entry. */
  produce: (item: K, index: number) => E | Promise<E>;
  /** Replacement entry for an item that cannot fit alone: carry `size` (its serialized bytes) and
   *  `budget` (the server byte budget). */
  tooLarge: (item: K, info: { size: number; budget: number }) => E;
  /** The tool's whole result object, built from entries. Called only with NO entries, to measure
   *  the fixed envelope; the caller calls it again to build the real result. */
  frame: (entries: E[], nextCursor: string | null) => unknown;
  /** Names the array field of `frame` an entry is placed in. Default: one shared lane. */
  lane?: (entry: E) => string;
  /** The JSON value an entry becomes inside `frame`'s array, when that differs from the entry
   *  itself (e.g. the entry is a tagged union and the array holds the payload). Default: identity.
   *  Byte accounting measures THIS, so it must be exactly what `frame` places. */
  wire?: (entry: E) => unknown;
}

export interface BytePage<E> {
  entries: E[];
  nextCursor: string | null;
}

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? "null", "utf8");

/** Args without `cursor`, so the hash of a resume call equals the hash of the original call. */
function bindingHash(tool: string, args: unknown): string {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    const { cursor: _cursor, ...rest } = args as Record<string, unknown>;
    return argsHash(tool, rest);
  }
  return argsHash(tool, args);
}

/** What a cursor is bound to: the tool, the caller, and the request (`cursor` excluded). */
export interface PageBinding {
  tool: string;
  principal: string | null;
  args: unknown;
}

// 128-bit digest (not throttle.ts callerHash, which is 8 hex for metric cardinality): this one is a
// security binding. `null` (stdio, no principal) is its own distinct value.
const principalDigest = (principal: string | null): string =>
  argsHash("principal", principal ?? null);

/** Mint a continuation cursor carrying `offset`, bound to `binding`. Not only for item lists: any
 *  paged read (get_provenance pages by record seq) takes its cursors from here, so a client cannot
 *  hand-make one. */
export function mintPageCursor(
  paging: PagingDeps,
  binding: PageBinding,
  offset: number,
): Promise<string> {
  return paging.codec.mint({
    v: 1,
    t: binding.tool,
    p: principalDigest(binding.principal),
    h: bindingHash(binding.tool, binding.args),
    o: offset,
  });
}

/** Verify a cursor against `binding` and return the offset it carries (a safe integer). Any
 *  failure is a structured `invalid_input` with `details.reason`: `expired`, `invalid` (bad
 *  signature / malformed / not issued by this server), `foreign` or `request_mismatch`. */
export async function readPageCursor(
  paging: PagingDeps,
  binding: PageBinding,
  cursor: string,
): Promise<number> {
  let payload: CursorPayload;
  try {
    payload = await paging.codec.verify(cursor);
  } catch (e) {
    const reason = (e as Error)?.message === "expired" ? "expired" : "invalid";
    throw err.invalidInput(`continuation cursor is ${reason}`, { reason });
  }
  const shapeOk =
    payload !== null &&
    typeof payload === "object" &&
    payload.v === 1 &&
    typeof payload.t === "string" &&
    typeof payload.p === "string" &&
    typeof payload.h === "string" &&
    Number.isSafeInteger(payload.o);
  if (!shapeOk) throw err.invalidInput("continuation cursor is invalid", { reason: "invalid" });
  if (payload.t !== binding.tool || payload.p !== principalDigest(binding.principal))
    throw err.invalidInput("continuation cursor was not issued to this caller for this tool", {
      reason: "foreign",
    });
  if (payload.h !== bindingHash(binding.tool, binding.args))
    throw err.invalidInput("continuation cursor does not match this request's arguments", {
      reason: "request_mismatch",
    });
  return payload.o;
}

async function startOffset<K, E>(o: PaginateByBytesOptions<K, E>) {
  if (o.cursor === undefined) return 0;
  const offset = await readPageCursor(o.paging, o.binding, o.cursor);
  if (offset < 1 || offset >= o.items.length)
    throw err.invalidInput("continuation cursor is out of range for this request", {
      reason: "invalid",
    });
  return offset;
}

export async function paginateByBytes<K, E>(o: PaginateByBytesOptions<K, E>): Promise<BytePage<E>> {
  const { tool } = o.binding;
  // 128-bit digest (not throttle.ts callerHash, which is 8 hex for metric cardinality): this one
  // is a security binding. `null` (stdio, no principal) is its own distinct value.
  const principal = argsHash("principal", o.binding.principal ?? null);
  const hash = bindingHash(tool, o.binding.args);
  const budget = o.paging.budgetBytes();
  const n = o.items.length;
  const start = await startOffset(o);

  const mint = (offset: number) =>
    o.paging.codec.mint({ v: 1, t: tool, p: principal, h: hash, o: offset });
  // Fixed envelope without / with a cursor. The worst-case cursor is the one for the highest
  // offset (longest digits), so any real cursor for this walk is no longer than the reserve.
  const envNone = bytes(o.frame([], null));
  const envCursor = bytes(o.frame([], await mint(n)));
  const laneOf = o.lane ?? (() => "");
  const wire = o.wire ?? ((e: E) => e as unknown);

  const entries: E[] = [];
  const usedAfter: number[] = []; // cumulative entry bytes (with commas) after each entry
  const laneCounts = new Map<string, number>();
  let used = 0;
  for (let i = start; i < n; i++) {
    const item = o.items[i] as K;
    let entry: E = await traceItem("batch_item", () => o.produce(item, i), i);
    let size = bytes(wire(entry));
    // Per item, position-independent: does it fit alone, with a cursor if anything follows it?
    if (size + (i === n - 1 ? envNone : envCursor) > budget) {
      entry = o.tooLarge(item, { size, budget });
      size = bytes(wire(entry));
    }
    const lane = laneOf(entry);
    const cost = size + ((laneCounts.get(lane) ?? 0) > 0 ? 1 : 0);
    // Does the page still fit if it ended here with NO cursor? (True for every entry when the whole
    // remainder fits: that is what makes "exactly at budget" one page.) The first entry of a page
    // is always taken: that is the progress guarantee.
    if (entries.length > 0 && used + cost + envNone > budget) {
      // Stopping here needs room for a cursor, which the entries taken under the looser no-cursor
      // test may not leave: cut back to the longest prefix that does (never below one entry).
      let keep = entries.length;
      while (keep > 1 && (usedAfter[keep - 1] as number) + envCursor > budget) keep--;
      return { entries: entries.slice(0, keep), nextCursor: await mint(start + keep) };
    }
    entries.push(entry);
    laneCounts.set(lane, (laneCounts.get(lane) ?? 0) + 1);
    used += cost;
    usedAfter.push(used);
  }
  return { entries, nextCursor: null };
}
