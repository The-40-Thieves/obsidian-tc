import { createHash } from "node:crypto";

// Deterministic, key-order-independent JSON serialisation: object keys are sorted recursively, so
// two structurally-identical values always serialise identically regardless of how they (or their
// nested objects) were built up. Exported for any other caller that needs a stable hash input from
// an object whose field insertion order isn't meaningful — e.g. search/representation.ts's
// representationManifestHash, which reuses this instead of a second canonicalizer.
export function canonicalJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

// 16-byte hex (32 chars). Same derivation for elicit tokens and idempotency keys.
export function argsHash(toolName: string, args: unknown): string {
  return createHash("sha256")
    .update(`${toolName} ${canonicalJson(args)}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}
