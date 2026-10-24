// get_conventions (domain metadata): the vault conventions that apply to a note or folder. The
// SCHEMA.md layers on its ancestor chain that carry a `conventions:` block, root first, and the merged
// rules they set, each with the layer it came from. A layer the caller cannot read is left out, never
// reported as denied. start_session reuses the root layer through rootConventionsFor.
import { grantsAll, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import {
  type ConventionsScope,
  conventionsLayerPaths,
  readConventionsLayer,
  resolveConventions,
} from "../../conventions/resolve";
import type { EffectiveConventions, SourcedValues } from "../../conventions/schema";
import type { CallerContext, ToolDefinition } from "../../mcp/registry";
import { normalizeVaultPath } from "../../vault/paths";
import { WIKI_SCHEMA_FILE } from "../m7/knowledge/wiki-schema";
import { ResponseFormatInput, resolveResponseFormat } from "../response-format";
import { defineTool } from "./define";
import type { M1Deps } from "./shared";

type ResolvedVault = ReturnType<M1Deps["vaultRegistry"]["resolve"]>;

/** The scope a caller's conventions are read under: the caller's own ACL, never a cached one. */
export function conventionsScopeOf(
  v: ResolvedVault,
  ctx: Pick<CallerContext, "acl" | "grantedScopes">,
): ConventionsScope {
  return {
    vaultId: v.id,
    root: v.root,
    acl: ctx.acl,
    grantedScopes: ctx.grantedScopes,
    wikiFolders: v.wikiFolders,
    rawFolders: v.rawFolders,
  };
}

/** The note path whose ancestor chain is the one asked about: a folder `a/b` probes `a/b/_.md`, the
 *  vault root probes `_.md`, and a note path stands for itself. Only its ancestors are ever read. */
function probeOf(rel: string): string {
  if (rel === "") return "_.md";
  return rel.endsWith(".md") ? rel : `${rel}/_.md`;
}

const SourcedList = z.object({ values: z.array(z.string()), source: z.string().optional() });

const Rules = z.object({
  required: SourcedList.optional(),
  values: z.record(z.string(), SourcedList),
});

/** The merged rules. `source` is present in the detailed form only; concise keeps the values. */
export const EffectiveConventionsOutput = Rules.extend({
  type_key: z.object({ value: z.string(), source: z.string().optional() }).optional(),
  types: z.record(z.string(), Rules),
});

const GetConventionsOutput = z.object({
  vault: z.string(),
  path: z.string(),
  layers: z
    .array(z.object({ path: z.string(), inherit: z.boolean(), version: z.number().int() }))
    .optional(),
  effective: EffectiveConventionsOutput,
  hint: z.string().optional(),
  file_warnings: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  file_warnings_omitted: z.number().int().optional(),
});

/** The effective rules in the wire shape. `withSource` false drops every `source` (concise). */
function effectiveOf(eff: EffectiveConventions, withSource: boolean) {
  const list = (s: SourcedValues) => (withSource ? s : { values: s.values });
  const rules = (values: Record<string, SourcedValues>, required?: SourcedValues) => ({
    ...(required ? { required: list(required) } : {}),
    values: Object.fromEntries(Object.entries(values).map(([k, s]) => [k, list(s)])),
  });
  return {
    ...(eff.typeKeySource !== ""
      ? {
          type_key: {
            value: eff.typeKey,
            ...(withSource ? { source: eff.typeKeySource } : {}),
          },
        }
      : {}),
    ...rules(eff.values, eff.required),
    types: Object.fromEntries(
      Object.entries(eff.types).map(([t, r]) => [t, rules(r.values, r.required)]),
    ),
  };
}

/** The root layer's effective rules in concise form, for start_session. Undefined unless the caller
 *  holds read:notes and the root SCHEMA.md carries a readable `conventions:` block. */
export function rootConventionsFor(
  v: ResolvedVault,
  ctx: Pick<CallerContext, "acl" | "grantedScopes">,
): z.infer<typeof EffectiveConventionsOutput> | undefined {
  if (!grantsAll(ctx.grantedScopes, ["read:notes"])) return undefined;
  const scope = conventionsScopeOf(v, ctx);
  if (readConventionsLayer(scope, WIKI_SCHEMA_FILE)?.layer == null) return undefined;
  return effectiveOf(resolveConventions(scope, "_.md"), false);
}

export function buildConventionsTools(deps: M1Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "get_conventions",
      domain: "metadata",
      description:
        "Return the vault conventions that apply to a note or folder: the SCHEMA.md layers that carry a conventions: block (root first, nearest last) and their merged rules (type key, required frontmatter, allowed values per property and per type), each with the layer it came from. Call it before creating or editing notes in a folder, to learn the required frontmatter and allowed values. Layers you cannot read are omitted. Domain: metadata. response_format=concise drops layers and every source.",
      inputSchema: z
        .object({ vault: VaultId, path: VaultPath.optional(), ...ResponseFormatInput })
        .strict(),
      outputSchema: GetConventionsOutput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = input.path === undefined ? "" : normalizeVaultPath(input.path);
        const probe = probeOf(rel);
        const scope = conventionsScopeOf(v, ctx);
        const eff = resolveConventions(scope, probe);
        const concise = resolveResponseFormat(input, deps.responseFormat) === "concise";
        const layers = conventionsLayerPaths(probe).flatMap((path) => {
          const layer = readConventionsLayer(scope, path)?.layer;
          return layer ? [{ path, inherit: layer.inherit, version: layer.version }] : [];
        });
        return {
          vault: v.id,
          path: rel,
          ...(concise ? {} : { layers }),
          effective: effectiveOf(eff, !concise),
          ...(layers.length === 0
            ? {
                hint: "No conventions apply here. To add them, put a conventions: block (version: 1) in a SCHEMA.md at the vault root or in this folder.",
              }
            : {}),
          ...(eff.fileWarnings.length > 0 ? { file_warnings: eff.fileWarnings } : {}),
          ...(eff.fileWarningsOmitted > 0
            ? { file_warnings_omitted: eff.fileWarningsOmitted }
            : {}),
        };
      },
    }),
  ];
}
