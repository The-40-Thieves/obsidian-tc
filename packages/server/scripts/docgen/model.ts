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
}

/** A typed error code from the ObsidianTcError taxonomy. */
export interface ErrorDoc {
  code: string;
  description?: string;
  /** HTTP-ish status class the dispatch layer maps this to, when applicable. */
  statusClass?: string;
}

/** A database table, extracted from the migrations + introspection. */
export interface TableDoc {
  name: string;
  columns: Array<{ name: string; type: string; notes?: string }>;
  indexes: string[];
}

/** The whole model. Extractors fill the slices they own; absent slices are empty arrays. */
export interface DocsModel {
  /** ISO date the model was generated (stamped by the CLI, not the extractors). */
  generatedAt?: string;
  tools: ToolDoc[];
  config: ConfigDoc[];
  metrics: MetricDoc[];
  errors: ErrorDoc[];
  tables: TableDoc[];
}

/** An empty model — extractors merge their slice into this. */
export function emptyModel(): DocsModel {
  return { tools: [], config: [], metrics: [], errors: [], tables: [] };
}
