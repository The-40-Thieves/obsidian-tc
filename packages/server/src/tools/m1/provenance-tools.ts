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
//   * a record naming several paths (move, copy, bulk) lists only the paths the caller may read.
import { err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { Database } from "../../db/types";
import type { ToolDefinition } from "../../mcp/registry";
import type { VaultAclResolver } from "../../mcp/resources";
import {
  MOVE_TOOLS,
  type QueryResult,
  queryNoteProvenance,
  type VisibleRecord,
} from "../../provenance/query";
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
  outcome: z.enum(["ok", "error"]),
  /** The path this record matched: the queried path, or an earlier path of the same note. */
  path: z.string(),
  /** sha256 of the matched path's bytes before and after the call, or `absent` / `unhashable`. */
  before: z.string().optional(),
  after: z.string().optional(),
  /** detailed only: every path of the record the caller may read. */
  paths: z.array(PathDigests).optional(),
  /** detailed only: the call named more paths than the record lists. */
  paths_truncated: z.literal(true).optional(),
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
});

const DEFAULT_LIMIT = 50;
const EMPTY: QueryResult = { records: [], hasMore: false, previousPaths: [] };

function verificationOf(
  deps: M1Deps,
  db: Database,
  r: VisibleRecord,
): z.infer<typeof Verification> {
  let resolveKey: KeyResolver | undefined;
  try {
    resolveKey = deps.provenanceKeys?.();
  } catch {
    resolveKey = undefined; // a lost registry: signatures cannot be checked, which is not "tampered"
  }
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
          ...(body.paths_omitted > 0 ? { paths_truncated: true as const } : {}),
          hash: r.row.hash,
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
      description: `Signed write history of one note: which mutating tool calls changed it, newest first, each with outcome, timestamp, sha256 before/after, and who made the call. \`verified\` holds what the server established (host, and the principal/persona/session only when a bearer token was verified); \`unauthenticated\` a caller label nobody proved; \`self_reported\` what the client claimed about itself (model, project, agent, client) and can be false. Moves (${[...MOVE_TOOLS].join(", ")}) are followed backwards to the note's earlier paths. Only paths you can read are listed, an unreadable path answers exactly like one with no history, and a record naming other paths never shows the ones you cannot read. include_verification re-checks each returned record's hash, signature and chain link (not whole-chain completeness: run \`obsidian-tc provenance verify\`). since/until are epoch milliseconds, inclusive. Needs read:provenance as well as read:notes. response_format=concise drops the host, the full path list, the record hash and machine.`,
      inputSchema: z
        .object({
          vault: VaultId,
          path: VaultPath,
          limit: z.number().int().positive().max(200).default(DEFAULT_LIMIT),
          cursor: z
            .string()
            .regex(/^[1-9]\d{0,15}$/, "cursor must be the next_cursor of a previous page")
            .optional(),
          since: z.number().int().nonnegative().optional(),
          until: z.number().int().nonnegative().optional(),
          include_verification: z.boolean().default(false),
          ...ResponseFormatInput,
        })
        .strict(),
      outputSchema: GetProvenanceOutput,
      requiredScopes: ["read:notes", "read:provenance"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        // The ACL of the vault being queried, not the caller's default: a vault with its own ACL
        // must not be judged by another's.
        const acl = aclFor(v.id) ?? ctx.acl;
        const readable = (p: string): boolean => readableRel(acl, p, ctx.grantedScopes);
        const result = readable(rel)
          ? queryNoteProvenance(ctx.db, {
              vaultId: v.id,
              path: rel,
              readable,
              beforeSeq: input.cursor !== undefined ? Number(input.cursor) : undefined,
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
              input.include_verification ? verificationOf(deps, ctx.db, r) : undefined,
            ),
          ),
          next_cursor: result.hasMore && last ? String(last.row.seq) : null,
        };
      },
    }),
  ];
}
