// Domain: write provenance, the per-note query (part B of signed write provenance). One tool,
// get_provenance: which mutating calls touched a note, newest first, with who the SERVER says made
// them kept apart from what the client SAID about itself.
//
// Trust and access, in one place:
//   * requires `read:provenance` ON TOP of `read:notes`. A record names the principal and session
//     of whoever wrote, which is audit data and not part of reading a note's content, so it is its
//     own grant. `read:*` and `*` include it.
//   * NO central `pathAcl`: that stage would answer an unreadable path with `acl_denied`, which
//     says "this note exists". The handler runs the one read predicate the search and link tools
//     use (`readableRel`) itself, and an unreadable path gets exactly the answer a path with no
//     records gets.
//   * a record naming several paths (move, copy, bulk) lists only the paths the caller may read,
//     and nothing derived from a dropped path leaves: not its name, not a count, not the stored
//     record hash (which covers it) and not a truncation flag.
//   * moves are followed backwards only through move records that verify; a record that does not
//     stops the walk and says so (`lineage_incomplete`).
import { err, type ServerConfig, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { Database } from "../../db/types";
import { mintPageCursor, pagingOf, readPageCursor } from "../../mcp/byte-page";
import type { ToolDefinition } from "../../mcp/registry";
import type { VaultAclResolver } from "../../mcp/resources";
import {
  DEFAULT_MAX_SCAN_ROWS,
  MOVE_TOOLS,
  type QueryResult,
  queryNoteProvenance,
  type VisibleRecord,
} from "../../provenance/query";
import type { ProvenanceRecorder } from "../../provenance/recorder";
import type { KeyResolver } from "../../provenance/signer";
import { verifyRecordAt } from "../../provenance/verify";
import { readableRel } from "../../vault/acl-read-filter";
import { normalizeVaultPath } from "../../vault/paths";
import { ResponseFormatInput, resolveResponseFormat } from "../response-format";
import { defineTool } from "./define";
import type { M1Deps } from "./shared";

const Verification = z.object({
  /** True only for a record whose hash, columns, chain link and signature all check out. */
  ok: z.boolean(),
  /** `valid` only when the signature verifies AND the body still hashes to the signed hash: a
   *  record whose content (or an indexed column) was edited is `invalid` even if the signature,
   *  which covers only the stored hash, still checks. A chain break is `chain_link`, not this. */
  signature: z.enum(["valid", "invalid", "unknown_key", "unsigned", "unverifiable"]),
  chain_link: z.enum(["ok", "broken"]),
  /** Problem codes of provenance verify, for this record only. */
  problems: z.array(z.string()),
});

const Verified = z.object({
  host: z.string().optional(),
  server_version: z.string().optional(),
  transport: z.enum(["stdio", "http"]).optional(),
  principal: z.string().optional(),
  persona: z.string().optional(),
  session_id: z.string().optional(),
});

const SelfReported = z.object({
  model: z.string().optional(),
  project: z.string().optional(),
  agent: z.string().optional(),
  machine: z.string().optional(),
  client: z.object({ name: z.string(), version: z.string().optional() }).optional(),
});

const PathDigests = z.object({ path: z.string(), before: z.string(), after: z.string() });

const ProvenanceRecordOut = z.object({
  seq: z.number(),
  ts: z.number(),
  tool: z.string(),
  outcome: z.enum(["ok", "error", "pending"]),
  /** The path this record matched: the queried path, or an earlier path of the same note. */
  path: z.string(),
  /** sha256 of the matched path's bytes before and after the call, or `absent` / `unhashable`. */
  before: z.string().optional(),
  after: z.string().optional(),
  /** detailed only: every path of the record the caller may read. */
  paths: z.array(PathDigests).optional(),
  /** detailed only: the call named more paths than the record lists. Never set on a record that
   *  had a path dropped for this caller: it would prove a path existed that they may not know of. */
  paths_truncated: z.literal(true).optional(),
  /** detailed only: the record's hash, or, when some of its paths are hidden from the caller, a
   *  hash of the view they can see (the stored hash covers the hidden paths). */
  hash: z.string().optional(),
  /** detailed only: the record was written while the chain head failed validation. */
  head_untrusted: z.literal(true).optional(),
  /** Established by the server; a client cannot influence any field here. */
  verified: Verified,
  /** A caller label the server saw but nobody proved (stdio, `auth.mode: none`). */
  unauthenticated: z.object({ principal: z.string().optional() }),
  /** Whatever the client said about itself. Never trust it for a decision. */
  self_reported: SelfReported,
  verification: Verification.optional(),
});

const GetProvenanceOutput = z.object({
  vault: z.string(),
  path: z.string(),
  /** Earlier paths of this note, reached by following moves backwards (readable ones only). */
  previous_paths: z.array(z.string()),
  records: z.array(ProvenanceRecordOut),
  next_cursor: z.string().nullable(),
  /** The scan row budget ran out: older history was not examined (`provenance.query.maxScanRows`). */
  scan_truncated: z.literal(true).optional(),
  /** Following moves backwards stopped at a record that failed verification (or the hop cap), so
   *  `previous_paths` and the earlier records are not complete. `reason` is a verify problem code,
   *  `unverifiable` (signed, no key registry) or `max_hops`. */
  lineage_incomplete: z.object({ reason: z.string(), seq: z.number() }).optional(),
});

const DEFAULT_LIMIT = 50;
const EMPTY: QueryResult = {
  records: [],
  hasMore: false,
  previousPaths: [],
  scanTruncated: false,
  rowsExamined: 0,
};

/** The M1Deps slice get_provenance reads from the recorder and the config: the registry's keys
 *  (read per call, the registry opens after the tools register) and the per-query row budget. */
export function provenanceDepsOf(
  recorder: ProvenanceRecorder,
  config: Pick<ServerConfig, "provenance">,
): Pick<M1Deps, "provenanceKeys" | "provenanceMaxScanRows"> {
  return {
    provenanceKeys: () => recorder.keyResolver(),
    provenanceMaxScanRows: config.provenance.query.maxScanRows,
  };
}

/** The registry's public keys, or undefined when there is none (stdio) or it is lost. A lost
 *  registry means signatures cannot be checked, which is not the same as tampering. */
function keysOf(deps: M1Deps): KeyResolver | undefined {
  try {
    return deps.provenanceKeys?.();
  } catch {
    return undefined;
  }
}

// Verify codes that say the record's CONTENT no longer matches what was signed. The signature
// covers only the stored hash, so it can verify over a record whose body was edited.
const CONTENT_PROBLEMS = new Set(["hash_mismatch", "column_mismatch", "malformed"]);

function verificationOf(
  resolveKey: KeyResolver | undefined,
  db: Database,
  r: VisibleRecord,
): z.infer<typeof Verification> {
  const { problems, signed } = verifyRecordAt(db, r.row, resolveKey ?? (() => undefined));
  const codes = problems.map((p) => p.code);
  const unverifiable = signed && resolveKey === undefined;
  const signature = !signed
    ? "unsigned"
    : unverifiable
      ? "unverifiable"
      : codes.includes("bad_signature")
        ? "invalid"
        : codes.includes("unknown_kid")
          ? "unknown_key"
          : codes.some((c) => CONTENT_PROBLEMS.has(c))
            ? "invalid"
            : "valid";
  const reported = unverifiable ? codes.filter((c) => c !== "unknown_kid") : codes;
  return {
    ok: reported.length === 0 && signature === "valid",
    signature,
    chain_link: codes.some((c) => c === "chain_break" || c === "seq_gap") ? "broken" : "ok",
    problems: reported,
  };
}

function recordOut(
  r: VisibleRecord,
  concise: boolean,
  verification: z.infer<typeof Verification> | undefined,
): z.infer<typeof ProvenanceRecordOut> {
  const { body } = r;
  const entry = r.paths.find((e) => e.path === r.matched);
  const v = body.verified ?? {};
  const sr = body.self_reported ?? {};
  return {
    seq: r.row.seq,
    ts: r.row.ts,
    tool: body.tool,
    outcome: body.outcome,
    path: r.matched,
    ...(entry ? { before: entry.before, after: entry.after } : {}),
    ...(concise
      ? {}
      : {
          paths: r.paths,
          ...(body.paths_omitted > 0 && !r.redacted ? { paths_truncated: true as const } : {}),
          hash: r.hash,
          ...(body.integrity !== undefined ? { head_untrusted: true as const } : {}),
        }),
    verified: concise
      ? {
          ...(v.principal !== undefined ? { principal: v.principal } : {}),
          ...(v.persona !== undefined ? { persona: v.persona } : {}),
          ...(v.session_id !== undefined ? { session_id: v.session_id } : {}),
        }
      : v,
    unauthenticated: body.unauthenticated ?? {},
    self_reported: concise ? { ...sr, machine: undefined } : sr,
    ...(verification ? { verification } : {}),
  };
}

export function buildProvenanceTools(deps: M1Deps, aclFor: VaultAclResolver): ToolDefinition[] {
  return [
    defineTool({
      name: "get_provenance",
      domain: "notes",
      description: `Signed write history of one note: which mutating tool calls changed it, newest first, each with outcome, timestamp, sha256 before/after, and who made the call. \`verified\` holds what the server established (host, and the principal/persona/session only when a bearer token was verified); \`unauthenticated\` a caller label nobody proved; \`self_reported\` what the client claimed about itself (model, project, agent, client) and can be false. Moves (${[...MOVE_TOOLS].join(", ")}) are followed backwards to the note's earlier paths, but only through move records that verify: a move that fails stops the walk and is reported as lineage_incomplete. One bounded pass over the chain: scan_truncated means the row budget ran out and older history was not examined. Only paths you can read are listed, an unreadable path answers exactly like one with no history, and a record naming other paths never shows the ones you cannot read (its hash is then a hash of the visible view). cursor is the signed next_cursor of a previous page of the same request. include_verification re-checks each returned record's hash, signature and chain link (not whole-chain completeness: run \`obsidian-tc provenance verify\`). since/until are epoch milliseconds, inclusive. Needs read:provenance as well as read:notes. response_format=concise drops the host, the full path list, the record hash and machine.`,
      inputSchema: z
        .object({
          vault: VaultId,
          path: VaultPath,
          limit: z.number().int().positive().max(200).default(DEFAULT_LIMIT),
          cursor: z
            .string()
            .min(1)
            .max(4096)
            .optional()
            .describe("The next_cursor of a previous page of this same request."),
          since: z.number().int().nonnegative().optional(),
          until: z.number().int().nonnegative().optional(),
          include_verification: z.boolean().default(false),
          ...ResponseFormatInput,
        })
        .strict(),
      outputSchema: GetProvenanceOutput,
      requiredScopes: ["read:notes", "read:provenance"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        // The ACL of the vault being queried, not the caller's default: a vault with its own ACL
        // must not be judged by another's.
        const acl = aclFor(v.id) ?? ctx.acl;
        const readable = (p: string): boolean => readableRel(acl, p, ctx.grantedScopes);
        // A cursor is one this server issued to this caller for this exact request (the signed
        // codec of the other paged reads); checked before anything touches the path, so a bad
        // cursor answers the same whether or not the path is readable.
        const paging = pagingOf(deps.paging);
        const binding = { tool: "get_provenance", principal: ctx.caller, args: input };
        const beforeSeq =
          input.cursor !== undefined
            ? await readPageCursor(paging, binding, input.cursor)
            : undefined;
        const resolveKey = keysOf(deps);
        const result = readable(rel)
          ? queryNoteProvenance(ctx.db, {
              vaultId: v.id,
              path: rel,
              readable,
              resolveKey,
              maxScanRows: deps.provenanceMaxScanRows ?? DEFAULT_MAX_SCAN_ROWS,
              beforeSeq,
              since: input.since,
              until: input.until,
              limit: input.limit,
            })
          : EMPTY;
        const filtered =
          input.cursor !== undefined || input.since !== undefined || input.until !== undefined;
        // A path with no visible history, and a path the caller may not read, throw the same error
        // with the same details. A later page or a time window may legitimately be empty.
        if (result.records.length === 0 && !filtered) {
          throw err.notFound("no provenance records for this path", { path: rel });
        }
        const concise = resolveResponseFormat(input, deps.responseFormat) === "concise";
        const last = result.records.at(-1);
        return {
          vault: v.id,
          path: rel,
          previous_paths: result.previousPaths,
          records: result.records.map((r) =>
            recordOut(
              r,
              concise,
              input.include_verification ? verificationOf(resolveKey, ctx.db, r) : undefined,
            ),
          ),
          next_cursor:
            result.hasMore && last ? await mintPageCursor(paging, binding, last.row.seq) : null,
          ...(result.scanTruncated ? { scan_truncated: true as const } : {}),
          ...(result.lineageIncomplete ? { lineage_incomplete: result.lineageIncomplete } : {}),
        };
      },
    }),
  ];
}
