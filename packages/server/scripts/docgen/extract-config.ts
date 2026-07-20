// docgen — config extractor (THE-471). Walks the exported ServerConfigObject (a Zod v4 ZodObject)
// into flat ConfigDoc[] entries: dotted key path, type, resolved default, optionality, description.
//
// Zod v4 introspection: every schema exposes `.def` with a `type` tag. Wrappers
// (default / prefault / optional / nullable) carry `{ innerType, defaultValue? }`; ZodObject exposes
// `.shape`; ZodArray carries `.def.element`; ZodEnum carries `.def.entries`. We unwrap wrappers to the
// leaf (collecting the default + optionality on the way), recurse into objects and array-of-object
// elements, and record a ConfigDoc for each scalar/enum/array leaf.
import { ServerConfigObject } from "@the-40-thieves/obsidian-tc-shared";
import type { ConfigDoc } from "./model";

// The Zod-internal surface we read. Kept local + loose so a Zod point-release can't break the build;
// unknown shapes degrade to a "unknown" type rather than throwing.
interface ZDef {
  type: string;
  innerType?: ZSchema;
  defaultValue?: unknown;
  element?: ZSchema;
  entries?: Record<string, unknown>;
}
interface ZSchema {
  def: ZDef;
  shape?: Record<string, ZSchema>;
  description?: string;
}

function resolveDefault(dv: unknown): unknown {
  try {
    return typeof dv === "function" ? (dv as () => unknown)() : dv;
  } catch {
    return undefined;
  }
}

/** Peel default/prefault/optional/nullable wrappers off `schema`, capturing default + optionality. */
function unwrap(schema: ZSchema): {
  leaf: ZSchema;
  optional: boolean;
  hasDefault: boolean;
  defaultValue?: unknown;
} {
  let s = schema;
  let optional = false;
  let hasDefault = false;
  let defaultValue: unknown;
  // A field can be wrapped several deep (e.g. .default().optional()); loop to the leaf.
  for (let guard = 0; guard < 8; guard++) {
    const t = s.def.type;
    if ((t === "optional" || t === "nullable") && s.def.innerType) {
      optional = true;
      s = s.def.innerType;
    } else if ((t === "default" || t === "prefault") && s.def.innerType) {
      optional = true; // a defaulted field may be omitted
      if (!hasDefault) defaultValue = resolveDefault(s.def.defaultValue); // keep the OUTERMOST default
      hasDefault = true;
      s = s.def.innerType;
    } else {
      break;
    }
  }
  return { leaf: s, optional, hasDefault, defaultValue };
}

function leafType(leaf: ZSchema): string {
  const t = leaf.def.type;
  if (t === "enum") {
    const vals = leaf.def.entries ? Object.values(leaf.def.entries) : [];
    return vals.length > 0 ? `enum(${vals.join("|")})` : "enum";
  }
  if (t === "array") {
    const el = leaf.def.element;
    return el ? `array<${el.def.type}>` : "array";
  }
  return t; // string | number | boolean | object | record | union | literal | ...
}

function walk(shape: Record<string, ZSchema>, prefix: string, out: ConfigDoc[]): void {
  for (const [key, field] of Object.entries(shape)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const { leaf, optional, hasDefault, defaultValue } = unwrap(field);
    const t = leaf.def.type;

    if (t === "object" && leaf.shape) {
      walk(leaf.shape, path, out); // recurse into a nested config section
      continue;
    }
    if (t === "array" && leaf.def.element?.def.type === "object" && leaf.def.element.shape) {
      // record the array itself, then its element's keys under `path[]`
      out.push({ path, type: leafType(leaf), optional, description: field.description });
      walk(leaf.def.element.shape, `${path}[]`, out);
      continue;
    }

    out.push({
      path,
      type: leafType(leaf),
      optional,
      ...(hasDefault ? { default: defaultValue } : {}),
      ...(field.description ? { description: field.description } : {}),
    });
  }
}

/** Extract every configuration key from ServerConfigObject as flat ConfigDoc[] (sorted by path). */
export function extractConfig(): ConfigDoc[] {
  const root = ServerConfigObject as unknown as ZSchema;
  const out: ConfigDoc[] = [];
  if (root.shape) walk(root.shape, "", out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
