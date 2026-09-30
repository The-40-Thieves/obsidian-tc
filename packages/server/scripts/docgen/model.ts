// docgen — the intermediate "docs model" (THE-471). Every extractor produces a slice of this one
// normalized structure; every renderer (THE-472) and the drift gate (THE-476) read it. Keeping the
// model as the single interface means a new doc surface never re-parses source.

/** A single MCP tool, extracted from the registry via describeCapability. */
export interface ToolDoc {
  name: string;
  description: string;
  requiredScopes: string[];
  tags: string[];
  destructive: boolean;
  /** JSON Schema (2020-12) of the input, from the tool's Zod inputSchema. */
  inputSchema: unknown;
  /** JSON Schema of the success payload, when the tool advertises an outputSchema. */
  outputSchema?: unknown;
  /** Facade domain id (`ToolDefinition.domain`). */
  domain?: string;
  /** The MCP tool annotations as advertised on the wire (read_only/destructive come from
   *  describeCapability; idempotent is the definition's advisory hint). */
  annotations?: { readOnly: boolean; destructive: boolean; idempotent: boolean };
  /** Human-confirmation (HITL) behaviour, read from the definition. */
  confirmation?: ToolConfirmationDoc;
  /** The input schema exposes a whole-operation idempotency key. */
  acceptsIdempotencyKey?: boolean;
}

/** What a tool's human confirmation looks like and what it binds to. */
export interface ToolConfirmationDoc {
  /** always: every call needs one. conditional: the handler asks only when a boundary is crossed. */
  required: "always" | "conditional" | "never";
  /** paths: the vault paths the input names (folder ACL). state: a fingerprint of the state being
   *  approved. arguments: the effect is opaque, so the argument hash alone. */
  binds: Array<"paths" | "state" | "arguments">;
}

/** A single configuration key, extracted from the config schema. `path` is dotted (e.g. "auth.mode"). */
export interface ConfigDoc {
  path: string;
  type: string;
  default?: unknown;
  optional: boolean;
  description?: string;
}

/** A Prometheus metric, extracted from the metrics registry. */
export interface MetricDoc {
  name: string;
  type: "counter" | "gauge" | "histogram" | "summary";
  help: string;
  labels: string[];
  /** Upper bucket bounds, histogram-only (THE-595). Undefined for every other type. */
  buckets?: number[];
}

/** A typed error code from the ObsidianTcError taxonomy. */
export interface ErrorDoc {
  code: string;
  description?: string;
  /** HTTP-ish status class the dispatch layer maps this to, when applicable. */
  statusClass?: string;
  /**
   * What to do about it (THE-512), read from `recoveryFor(code)`. Distinct from `description`,
   * which says what went wrong. Undefined where the taxonomy declares `null` — a considered
   * "no hint helps" rather than a gap, since `RECOVERY` is `Record<ErrorCode, …>` and adding a
   * code fails to compile until it declares one.
   */
  recovery?: string;
}

/** The whole model. Extractors fill the slices they own; absent slices are empty arrays. */
export interface DocsModel {
  /** ISO date the model was generated (stamped by the CLI, not the extractors). */
  generatedAt?: string;
  tools: ToolDoc[];
  config: ConfigDoc[];
  metrics: MetricDoc[];
  errors: ErrorDoc[];
}

/** An empty model — extractors merge their slice into this. */
export function emptyModel(): DocsModel {
  return { tools: [], config: [], metrics: [], errors: [] };
}
