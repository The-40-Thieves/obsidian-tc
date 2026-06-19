// JSONCanvas (.canvas) codec — implements the JSONCanvas 1.0 spec: nodes of type
// text|file|link|group, edges, and colors. Round-trip fidelity is mandatory:
// parseCanvas keeps every key Obsidian or a plugin wrote (validation is shape-only,
// via passthrough schemas), and all mutations operate on the parsed object in place
// so unknown node/edge/top-level fields survive serialization unchanged. Malformed
// JSON, a non-object root, or a structurally invalid canvas throws invalid_input.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";

const Side = z.enum(["top", "right", "bottom", "left"]);
const End = z.enum(["none", "arrow"]);

export const CanvasNodeType = z.enum(["text", "file", "link", "group"]);

// Per-node schema. Geometry + id + type are required by the spec; type-specific
// fields are optional and passthrough preserves anything else a writer added.
export const CanvasNode = z
  .object({
    id: z.string().min(1),
    type: CanvasNodeType,
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    color: z.string().optional(),
    text: z.string().optional(),
    file: z.string().optional(),
    subpath: z.string().optional(),
    url: z.string().optional(),
    label: z.string().optional(),
  })
  .passthrough();

export const CanvasEdge = z
  .object({
    id: z.string().min(1),
    fromNode: z.string().min(1),
    fromSide: Side.optional(),
    fromEnd: End.optional(),
    toNode: z.string().min(1),
    toSide: Side.optional(),
    toEnd: End.optional(),
    color: z.string().optional(),
    label: z.string().optional(),
  })
  .passthrough();

export const CanvasDoc = z
  .object({
    nodes: z.array(CanvasNode).default([]),
    edges: z.array(CanvasEdge).default([]),
  })
  .passthrough();

export type CanvasNodeT = z.infer<typeof CanvasNode>;
export type CanvasEdgeT = z.infer<typeof CanvasEdge>;

export interface ParsedCanvas {
  /** The on-disk object — mutate this for writes so unknown keys are preserved. */
  raw: Record<string, unknown>;
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
}

/** Parse + structurally validate a .canvas document. Throws invalid_input. */
export function parseCanvas(text: string): ParsedCanvas {
  let obj: unknown;
  try {
    obj = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw err.invalidInput("canvas is not valid JSON");
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj))
    throw err.invalidInput("canvas root must be a JSON object");
  const raw = obj as Record<string, unknown>;
  if (raw.nodes === undefined) raw.nodes = [];
  if (raw.edges === undefined) raw.edges = [];
  const res = CanvasDoc.safeParse(raw);
  if (!res.success)
    throw err.invalidInput("canvas structure is invalid", { issues: res.error.issues });
  return {
    raw,
    nodes: raw.nodes as Record<string, unknown>[],
    edges: raw.edges as Record<string, unknown>[],
  };
}

/** Serialize a canvas object (the raw, mutated form) back to JSON text. */
export function serializeCanvas(
  raw: Record<string, unknown>,
  indent: string | number = "\t",
): string {
  return `${JSON.stringify(raw, null, indent)}\n`;
}

/** Project a raw node onto the G2.1 read_canvas output shape. */
export function projectNode(n: Record<string, unknown>): Record<string, unknown> {
  return {
    id: n.id,
    type: n.type,
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
    ...(n.color !== undefined ? { color: n.color } : {}),
    ...(n.text !== undefined ? { text: n.text } : {}),
    ...(n.file !== undefined ? { file: n.file } : {}),
    ...(n.subpath !== undefined ? { subpath: n.subpath } : {}),
    ...(n.url !== undefined ? { url: n.url } : {}),
    ...(n.label !== undefined ? { label: n.label } : {}),
  };
}

/** Project a raw edge onto the G2.1 read_canvas output shape. */
export function projectEdge(e: Record<string, unknown>): Record<string, unknown> {
  return {
    id: e.id,
    fromNode: e.fromNode,
    ...(e.fromSide !== undefined ? { fromSide: e.fromSide } : {}),
    toNode: e.toNode,
    ...(e.toSide !== undefined ? { toSide: e.toSide } : {}),
    ...(e.color !== undefined ? { color: e.color } : {}),
    ...(e.label !== undefined ? { label: e.label } : {}),
  };
}
