// The SDK's default-on legacy input-required shim owns the confirm leg on a 2025-era (stdio)
// connection. When that leg fails (the client errors, or nothing answers inside the round timeout)
// the shim returns its OWN "Fulfilling input required ... failed" result and never re-enters our
// handler, so no `approval_not_obtained` reason and no mint route reach the model. The shim has no
// hook for that, but `Server._wrapHandler` is a protected extension point that sees the final
// result of every `tools/call`, so this subclass uses it to notice the case and substitute our
// own refusal. It only ever turns a result into a refusal; it cannot produce an approval.
import {
  type CallToolResult,
  isInputRequiredResult,
  type JSONRPCRequest,
  type Result,
  Server,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { ErrorJSON } from "@the-40-thieves/obsidian-tc-shared";
import { offeredElicitError } from "./elicit-form";

export class ShimGuardedServer extends Server {
  /** Builds the refusal for an offered confirmation whose leg failed. Unset: SDK result as-is. */
  onConfirmLegFailure?: (error: ErrorJSON) => CallToolResult;

  protected override _wrapHandler(
    method: string,
    handler: (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result>,
  ): (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result> {
    if (method !== "tools/call") return super._wrapHandler(method, handler);
    return async (request, ctx) => {
      // What our handler returned last. The shim re-enters it after every successful leg, so if
      // that was still an offer when the SDK produced a final (non-input-required) result, the
      // shim itself ended the call: the leg failed, timed out, or the round cap was hit.
      let last: unknown;
      const wrapped = super._wrapHandler(method, async (req, c) => {
        last = await handler(req, c);
        return last as Result;
      });
      const result = await wrapped(request, ctx);
      const offered = offeredElicitError(last);
      if (offered === undefined || isInputRequiredResult(result) || !this.onConfirmLegFailure) {
        return result;
      }
      return this.onConfirmLegFailure(offered);
    };
  }
}
