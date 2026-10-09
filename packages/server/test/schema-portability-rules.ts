// The portable-subset rules every ADVERTISED tool schema (inputSchema / outputSchema, in every facade
// mode and tool profile) must satisfy. Each rule below is a failure some shipping MCP client has
// actually produced, so it is a red case in schema-portability.test.ts, not an invented lint:
//
//  - `$ref` / `$defs`: Copilot Studio silently filters the tool out; Codex collapses a `$ref`
//    to `"type":"string"`; Gemini / Vertex / ADK reject an unresolved one.
//  - `type` arrays: Copilot Studio truncates the schema at the array.
//  - numeric `exclusiveMinimum` / `exclusiveMaximum`: Copilot Studio throws FormatException (it
//    expects the draft-04 boolean form, which would break every 2020-12 validator, so neither form
//    is advertised).
//  - an outputSchema whose root is not `type: object`: Cursor shows the whole server with zero tools.
//  - root `anyOf` / `oneOf` / `allOf` / `not`: the Anthropic API rejects the request, OpenAI models
//    reject the tool.
//  - `const`, `oneOf`, `allOf`, `not`, `if`, `propertyNames`: outside the OpenAPI 3.0 subset Gemini /
//    Vertex / ADK accept (adk-go passes MCP schemas through verbatim).
//  - arrays without `items`, non-string enums, `anyOf` with sibling keywords, `additionalProperties`
//    inside an `anyOf` branch: Gemini 400s (gemini-cli, adk-python, backstage, mcp-atlassian reports).
//  - regex lookaround / backreference in `pattern`, `format` outside OpenAI's list: OpenAI rejects.
//  - a draft-07 `$schema`: Claude Desktop fails every call client-side.
//  - a schema over 16 KiB: claude.ai's connector ingestion dropped such tools.
//
// A rule is either about the schema alone or about the role it plays (`input` / `output`): a nullable
// OUTPUT field keeps its `{type:"null"}` branch because a client validating `structuredContent`
// against it must still accept the `null` the server really sends.

import type { SchemaRole } from "../src/mcp/schema-lowering";

export const MAX_SCHEMA_BYTES = 16 * 1024;
export const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
// OpenAI structured-outputs `format` list.
export const PORTABLE_FORMATS: ReadonlySet<string> = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);
const TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
  "null",
]);
const FORBIDDEN_KEYWORDS = [
  "$ref",
  "$defs",
  "definitions",
  "$id",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "const",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "prefixItems",
  "propertyNames",
  "patternProperties",
  "dependentSchemas",
  "dependentRequired",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "exclusiveMinimum",
  "exclusiveMaximum",
];
const LOOKAROUND_OR_BACKREF = /\(\?<?[=!]|\\[1-9]|\\k</;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

function walk(
  node: unknown,
  path: string,
  inAnyOf: boolean,
  role: SchemaRole,
  out: string[],
): void {
  if (!isObj(node)) {
    out.push(`${path}: sub-schema is not an object (boolean sub-schemas blank some clients)`);
    return;
  }
  for (const kw of FORBIDDEN_KEYWORDS)
    if (kw in node) out.push(`${path}: forbidden keyword "${kw}"`);
  if (Array.isArray(node.type)) out.push(`${path}: "type" is an array`);
  else if (node.type !== undefined && !(typeof node.type === "string" && TYPES.has(node.type)))
    out.push(`${path}: unknown type ${JSON.stringify(node.type)}`);
  if (node.type === "null" && role === "input")
    out.push(`${path}: {type:"null"} advertised on an input (make the field optional instead)`);
  if (node.type === "array" && !isObj(node.items)) out.push(`${path}: array without "items"`);
  if (Array.isArray(node.enum)) {
    if (!node.enum.every((v) => typeof v === "string")) out.push(`${path}: non-string enum`);
    if (node.type !== undefined && node.type !== "string")
      out.push(`${path}: enum on non-string type`);
  }
  if (typeof node.pattern === "string" && LOOKAROUND_OR_BACKREF.test(node.pattern))
    out.push(`${path}: pattern uses lookaround or a backreference`);
  if (typeof node.format === "string" && !PORTABLE_FORMATS.has(node.format))
    out.push(`${path}: format "${node.format}" is outside the portable list`);
  if (Array.isArray(node.required) && new Set(node.required).size !== node.required.length)
    out.push(`${path}: duplicate "required" entries`);
  if (inAnyOf && "additionalProperties" in node)
    out.push(`${path}: additionalProperties inside an anyOf branch`);
  if ("anyOf" in node) {
    const extra = Object.keys(node).filter((k) => k !== "anyOf");
    if (extra.length > 0) out.push(`${path}: anyOf has sibling keywords (${extra.join(", ")})`);
    if (!Array.isArray(node.anyOf) || node.anyOf.length < 2)
      out.push(`${path}: anyOf with fewer than two branches`);
  }
  const child = (v: unknown, p: string, anyOfBranch: boolean): void =>
    walk(v, p, anyOfBranch || inAnyOf, role, out);
  if (Array.isArray(node.anyOf))
    for (const [i, b] of node.anyOf.entries()) child(b, `${path}.anyOf[${i}]`, true);
  if (isObj(node.properties))
    for (const [k, v] of Object.entries(node.properties))
      child(v, `${path}.properties.${k}`, false);
  if (isObj(node.items)) child(node.items, `${path}.items`, false);
  if (isObj(node.additionalProperties))
    child(node.additionalProperties, `${path}.additionalProperties`, false);
}

/** Every way `schema` falls outside the portable subset; `[]` means portable. */
export function portabilityViolations(schema: unknown, role: SchemaRole): string[] {
  const out: string[] = [];
  if (!isObj(schema)) return ["root: schema is not an object"];
  if (schema.type !== "object")
    out.push(`root: type is ${JSON.stringify(schema.type)}, not "object"`);
  for (const k of ["anyOf", "oneOf", "allOf", "not", "enum", "const", "$ref"])
    if (k in schema) out.push(`root: has "${k}"`);
  if ("$schema" in schema && schema.$schema !== JSON_SCHEMA_2020_12)
    out.push(`root: $schema is ${JSON.stringify(schema.$schema)}, not JSON Schema 2020-12`);
  const { $schema: _dropped, ...body } = schema;
  walk(body, "root", false, role, out);
  const bytes = Buffer.byteLength(JSON.stringify(schema), "utf8");
  if (bytes > MAX_SCHEMA_BYTES)
    out.push(`root: ${bytes} bytes exceeds the ${MAX_SCHEMA_BYTES}-byte cap`);
  return out;
}
