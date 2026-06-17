import { z } from "zod";
import { ObsidianTcError, grantsAll, scopeRequiresHitl, type ToolResult } from "@obsidian-tc/shared";
import { argsHash } from "../hash";
import { writeEvent, type AuditEvent } from "../audit";
import type { Database } from "../db/types";

export interface CallerContext {
  caller: string | null;
  authenticated: boolean;
  grantedScopes: Set<string>;
  vaultId: string;
  db: Database;
  elicitToken?: string | null;
  now?: () => number;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  requiredScopes: string[];
  destructive?: boolean;
  handler: (input: I, ctx: CallerContext) => Promise<O> | O;
}

type VerifyElicit = (token: string, expectedHash: string, ctx: CallerContext) => boolean;
type Status = "ok" | "error" | "skipped";

export interface RegistryOptions { maxResponseBytes?: number; verifyElicit?: VerifyElicit; }

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<any, any>>();
  private readonly maxResponseBytes: number;
  private readonly verifyElicit?: VerifyElicit;

  constructor(opts: RegistryOptions = {}) {
    this.maxResponseBytes = opts.maxResponseBytes ?? 1_000_000;
    this.verifyElicit = opts.verifyElicit;
  }

  register(def: ToolDefinition<any, any>): void {
    if (this.tools.has(def.name)) throw new Error(`duplicate tool: ${def.name}`);
    this.tools.set(def.name, def);
  }
  list(): ToolDefinition[] { return [...this.tools.values()]; }
  has(name: string): boolean { return this.tools.has(name); }

  // Full invocation pipeline: validate -> auth -> scope/ACL -> HITL -> execute -> governor -> audit.
  async dispatch(name: string, rawInput: unknown, ctx: CallerContext): Promise<ToolResult> {
    const now = ctx.now ?? Date.now;
    const start = now();
    const hash = argsHash(name, rawInput ?? {});

    const audit = (status: Status, durationMs: number, resultSize: number, code?: string) => {
      try {
        const e: AuditEvent = {
          ts: Date.now(), vault_id: ctx.vaultId, tool_name: name, caller: ctx.caller,
          duration_ms: durationMs, result_size: resultSize, status,
          error_code: code ?? null, args_hash: hash, event_type: "tool_invocation",
        };
        writeEvent(ctx.db, e);
      } catch { /* audit must never break dispatch */ }
    };

    try {
      const def = this.tools.get(name);
      if (!def) throw new ObsidianTcError("not_found", `unknown tool: ${name}`);

      const parsed = def.inputSchema.safeParse(rawInput);
      if (!parsed.success)
        throw new ObsidianTcError("validation_error", "input validation failed", { issues: parsed.error.issues });

      if (def.requiredScopes.length > 0 && !ctx.authenticated)
        throw new ObsidianTcError("unauthorized", "authentication required for this tool");

      if (!grantsAll(ctx.grantedScopes, def.requiredScopes))
        throw new ObsidianTcError("forbidden", "missing required scope(s)", { required: def.requiredScopes });

      const needsHitl = def.destructive === true || def.requiredScopes.some(scopeRequiresHitl);
      if (needsHitl) {
        const ok = !!ctx.elicitToken && !!this.verifyElicit && this.verifyElicit(ctx.elicitToken, hash, ctx);
        if (!ok) throw new ObsidianTcError("elicit_required", "human confirmation required", { args_hash: hash });
      }

      const out = await def.handler(parsed.data, ctx);
      const json = JSON.stringify(out ?? null);
      const resultSize = Buffer.byteLength(json, "utf8");
      const duration = Math.max(0, now() - start);

      if (resultSize > this.maxResponseBytes) {
        const e = new ObsidianTcError("overflow", "response exceeds byte budget", {
          result_size: resultSize, limit: this.maxResponseBytes,
        });
        audit("error", duration, resultSize, e.code);
        return { ok: false, error: e.toJSON(), meta: { duration_ms: duration, result_size: resultSize, overflow_bytes: resultSize - this.maxResponseBytes } };
      }

      audit("ok", duration, resultSize);
      return { ok: true, data: out, meta: { duration_ms: duration, result_size: resultSize } };
    } catch (e) {
      const error = e instanceof ObsidianTcError ? e : new ObsidianTcError("internal", (e as Error).message);
      const duration = Math.max(0, now() - start);
      audit("error", duration, 0, error.code);
      return { ok: false, error: error.toJSON(), meta: { duration_ms: duration, result_size: 0 } };
    }
  }
}
