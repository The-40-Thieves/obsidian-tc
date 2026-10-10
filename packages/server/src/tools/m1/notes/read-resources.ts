// read_resources: MCP resources/read is one URI per call and MCP has no JSON-RPC batching, so the
// bulk form is a tool with an array parameter. Each URI is resolved by readResource() (mcp/
// resources.ts) - the very function the resources/read handler calls - so URI parsing, the bound-
// vault check, folder/rule-scope ACL and the size ceiling are the resource surface's, not a copy.
// Paging is the shared byte-page.ts paginator, exactly as read_notes uses it.
//
// ACL: enforced per item inside readResource, on every page, under the ACL of the vault each URI
// resolves to: the per-vault override when one is configured, else the root ACL (the registry's own
// aclResolver, passed in as `aclFor` - this tool has no `vault` argument, so dispatch's per-vault
// swap never runs for it). Granted scopes are passed too, so rule-scopes apply. No central
// `pathAcl` is declared on purpose: the central stage throws for the WHOLE call on the first denied
// path, and its extractor cannot see the caller's bound vault, so a denied or foreign-vault URI
// would sink the batch instead of being one error item. Because that also hides a denial from
// dispatch's denial signals, `deniedItems` hands them back (audit row, acl_denied_total,
// tc.acl.denied per denied item, as read_notes gets for a denied path).
// memoryDefense is a write-side gate (write_note/append_note/patch_note); no read path runs it, so
// there is nothing to evaluate per item here - the same as read_notes.
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { paginateByBytes, pagingOf } from "../../../mcp/byte-page";
import type { ToolDefinition } from "../../../mcp/registry";
import { readResource, type VaultAclResolver } from "../../../mcp/resources";
import { ResponseFormatInput, resolveResponseFormat } from "../../response-format";
import { defineTool } from "../define";
import type { M1Deps } from "../shared";
import { ReadResourcesOutput } from "./schemas";

type ReadResourcesItem = z.infer<typeof ReadResourcesOutput>["results"][number];

export function createReadResourcesTool(deps: M1Deps, aclFor: VaultAclResolver): ToolDefinition {
  return defineTool({
    name: "read_resources",
    wholeNotes: true,
    domain: "notes",
    description:
      "Batch resources/read: read many obsidian-tc://<vault>/<path> note resource URIs in one call. Returns one result per URI in request order: {ok: true, uri, mimeType, text} (identical to a single resources/read) or {ok: false, uri, error} for a malformed or unsupported URI, another vault's URI, a denied or missing note. The response is held under the server's byte budget: when the batch does not fit, the results that fit are returned with next_cursor; call again with the same arguments plus cursor to continue exactly where the page stopped (request order, no duplicates, no gaps) until next_cursor is null. A single resource too large to ever fit is reported as a too_large error (with its size and the budget) and skipped, so the walk always makes progress. A cursor is bound to the caller, the tool and these exact arguments, and expires. response_format=concise returns each item as {ok: true, uri, text} with the note body only (no frontmatter block, no mimeType); error items are unchanged.",
    inputSchema: z
      .object({
        uris: z.array(z.string().min(1).max(4096)).min(1).max(100),
        cursor: z
          .string()
          .min(1)
          .max(4096)
          .optional()
          .describe("The next_cursor of a previous page of this same request."),
        ...ResponseFormatInput,
      })
      .strict(),
    outputSchema: ReadResourcesOutput,
    requiredScopes: ["read:notes"],
    // A denied URI is an item, not a failed call (see the ACL note above), so dispatch is told how
    // to find the denials and records each one as it would a thrown acl_denied.
    deniedItems: (out) => out.results.flatMap((r) => (r.ok ? [] : [r.error.code])),
    handler: async (input, ctx) => {
      const paging = pagingOf(deps.paging);
      const format = resolveResponseFormat(input, deps.responseFormat);
      const { entries, nextCursor } = await paginateByBytes<string, ReadResourcesItem>({
        paging,
        binding: { tool: "read_resources", principal: ctx.caller, args: input },
        cursor: input.cursor,
        items: input.uris,
        // Runs per item on every page, so a folder ACL revoked between pages is honoured on resume.
        produce: (uri): ReadResourcesItem => {
          try {
            const content = readResource(
              deps.vaultRegistry,
              ctx,
              uri,
              paging.budgetBytes(),
              aclFor,
              format,
            ).contents[0];
            if (!content || !("text" in content))
              throw new ObsidianTcError("internal", "resource has no text content");
            return format === "concise"
              ? { ok: true, uri: content.uri, text: content.text }
              : {
                  ok: true,
                  uri: content.uri,
                  mimeType: content.mimeType ?? "",
                  text: content.text,
                };
          } catch (e) {
            if (!(e instanceof ObsidianTcError)) throw e;
            const { size, budget } = e.details ?? {};
            // readResource's own size ceiling is this tool's too_large, same shape as the paginator's.
            if (typeof size === "number" && typeof budget === "number")
              return tooLarge(uri, size, budget);
            return { ok: false, uri, error: { code: e.code, message: e.message } };
          }
        },
        tooLarge: (uri, { size, budget }) => tooLarge(uri, size, budget),
        frame: (results, next) => ({ results, next_cursor: next }),
        lane: () => "results",
      });
      return { results: entries, next_cursor: nextCursor };
    },
  });
}

function tooLarge(uri: string, size: number, budget: number): ReadResourcesItem {
  return {
    ok: false,
    uri,
    error: {
      code: "too_large",
      message: "resource is larger than the response byte budget and cannot be returned",
      size,
      budget,
    },
  };
}
