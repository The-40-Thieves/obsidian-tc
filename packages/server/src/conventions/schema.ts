// Vault conventions: the `conventions:` block of a SCHEMA.md layer, the merged rules a note is
// checked against, and the warning shape a result carries. The engine has no tool surface yet; the
// shapes here are the contract the tools that expose it will spread into their output schemas.
import { z } from "zod";
import type { RawFolders, WikiFolders } from "../tools/m7/knowledge/wiki-folder";

/** The frontmatter key a SCHEMA.md layer opts in with. */
export const CONVENTIONS_KEY = "conventions";

/** The only `conventions.version` this server reads; a higher one is ignored with a warning. */
export const CONVENTIONS_VERSION = 1;

/** Per-type rules a layer sets. `undefined` = not set here; `[]` = removes the inherited rule. */
export interface ConventionsTypeLayer {
  required?: string[];
  values: Record<string, string[]>;
}

/** One parsed SCHEMA.md layer. Keys are null-prototype maps: a property may be named `__proto__`. */
export interface ConventionsLayer {
  /** Vault-relative path of the SCHEMA.md this layer was read from. */
  path: string;
  version: number;
  inherit: boolean;
  /** Frontmatter property naming a page's type; `undefined` = not set by this layer. */
  typeKey?: string;
  /** Global required fields; `undefined` = not set here, `[]` = removes the inherited list. */
  required?: string[];
  /** Global allowed values per property; `[]` removes the inherited rule for that property. */
  values: Record<string, string[]>;
  types: Record<string, ConventionsTypeLayer>;
}

export interface ParsedConventionsLayer {
  layer: ConventionsLayer | null;
  warnings: string[];
  /** The file has legacy wiki `types`/`properties` and no `conventions:` block. */
  legacyOnly: boolean;
}

/** A merged rule and the layer that set it. */
export interface SourcedValues {
  values: string[];
  source: string;
}

export interface EffectiveTypeRules {
  required?: SourcedValues;
  values: Record<string, SourcedValues>;
}

export interface ConventionsFileWarning {
  path: string;
  message: string;
}

/** The merged rules that apply to one note, nearest layer winning per leaf key. */
export interface EffectiveConventions {
  typeKey: string;
  typeKeySource: string;
  required?: SourcedValues;
  values: Record<string, SourcedValues>;
  types: Record<string, EffectiveTypeRules>;
  wikiFolders: WikiFolders;
  rawFolders: RawFolders;
  fileWarnings: ConventionsFileWarning[];
}

export const CONVENTION_CODES = [
  "missing_required",
  "value_not_allowed",
  "type_not_scalar",
  "value_not_scalar",
] as const;

export const ConventionWarningSchema = z.object({
  path: z.string(),
  code: z.enum(CONVENTION_CODES),
  property: z.string().optional(),
  message: z.string(),
  values: z.array(z.string()).optional(),
  allowed: z.array(z.string()).optional(),
  type: z.string().optional(),
  source: z.string(),
  level: z.literal("warn"),
});

export type ConventionWarning = z.infer<typeof ConventionWarningSchema>;

/** Spread into a tool's output schema. The key is absent when the check was clean. */
export const conventionsResultShape = {
  conventions: z
    .object({
      warnings: z.array(ConventionWarningSchema).optional(),
      warnings_omitted: z.number().int().optional(),
      file_warnings: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    })
    .optional(),
};
