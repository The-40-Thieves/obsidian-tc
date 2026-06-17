import { createHash } from "node:crypto";

function canonical(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}

// 16-byte hex (32 chars). Same derivation for elicit tokens and idempotency keys.
export function argsHash(toolName: string, args: unknown): string {
  return createHash("sha256").update(toolName + " " + canonical(args), "utf8").digest("hex").slice(0, 32);
}
