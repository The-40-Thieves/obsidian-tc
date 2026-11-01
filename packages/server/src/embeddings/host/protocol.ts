// GH #1433 rec 4, step 2: the NDJSON protocol between the child-process EmbedderHost (child-process.ts)
// and the embedder child (child-main.ts). One JSON object per line, `v: 1`. The child's stdout carries
// nothing but these lines, so a line that does not parse, carries another version, or names an unknown
// message is rejected: the parent treats a rejected line as a child crash.

export const PROTOCOL_VERSION = 1;

export interface EmbedderInitOpts {
  model: string;
  quantized: boolean;
  threads?: number;
  modelsRoot: string;
  cacheDir: string;
}

export type ParentMessage =
  | { t: "init"; v: 1; opts: EmbedderInitOpts }
  | { t: "embed"; v: 1; id: number; texts: string[]; opts?: unknown }
  | { t: "stats"; v: 1; id: number }
  | { t: "shutdown"; v: 1 };

export type ChildMessage =
  | { t: "ready"; v: 1; pid: number }
  | { t: "result"; v: 1; id: number; vectors: number[][] }
  | { t: "error"; v: 1; id: number | "init"; message: string }
  | { t: "stats"; v: 1; id: number; rssBytes: number };

export type ProtocolMessage = ParentMessage | ChildMessage;

const KINDS = new Set(["init", "embed", "stats", "shutdown", "ready", "result", "error"]);

export function encodeMessage(message: ProtocolMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** Parses one protocol line. Throws on a line that is not a JSON object, carries another version,
 *  names an unknown message, or is a result without its vectors. */
export function parseMessage(line: string): ProtocolMessage {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null) {
    throw new Error("embedder protocol: a line is not a JSON object");
  }
  const message = value as Record<string, unknown>;
  if (message.v !== PROTOCOL_VERSION) {
    throw new Error(`embedder protocol: unsupported version ${String(message.v)}`);
  }
  if (typeof message.t !== "string" || !KINDS.has(message.t)) {
    throw new Error(`embedder protocol: unknown message ${String(message.t)}`);
  }
  if (message.t === "result" && !Array.isArray(message.vectors)) {
    throw new Error("embedder protocol: result without vectors");
  }
  return value as ProtocolMessage;
}
