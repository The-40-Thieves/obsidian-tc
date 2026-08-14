// Domain 9 — Excalidraw (G2.1). Three tools proxied to the companion plugin's
// /excalidraw/* routes (the Excalidraw drawing model — compressed-JSON scenes and
// text elements — lives in the live plugin, so these route through the bridge and
// degrade to plugin_missing/plugin_unreachable when Excalidraw or the companion is
// absent). Reads take read:excalidraw; create/update take write:excalidraw (write
// family, conditional HITL on overwrite — not the always-elicit execute floor).
import {
  ElicitToken,
  err,
  ObsidianTcError,
  VaultId,
  VaultPath,
} from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { requireConfirmation } from "../../vault/hitl";
import { noteExists, readNote } from "../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openBridge } from "./shared";

const ElementArray = z.array(z.record(z.string(), z.unknown()));

type Obj = Record<string, unknown>;

// THE-202: pure-filesystem parse so read_excalidraw works headlessly (no companion/plugin).
// The .excalidraw form is pure JSON; the plugin's .excalidraw.md wrapper embeds the drawing in a
// fenced code block (often LZ-compressed — then only the text elements are recoverable).
function excalidrawKind(rel: string): "json" | "md" | null {
  const l = rel.toLowerCase();
  if (l.endsWith(".excalidraw.md")) return "md";
  if (l.endsWith(".excalidraw")) return "json";
  return null;
}

function textFromElements(elements: unknown[]): string {
  return elements
    .filter((e): e is Obj => !!e && typeof e === "object" && !Array.isArray(e))
    .filter((e) => e.type === "text" && typeof e.text === "string")
    .map((e) => e.text as string)
    .join("\n");
}

function sectionBody(md: string, heading: string): string {
  const i = md.indexOf(heading);
  if (i < 0) return "";
  const after = md.slice(i + heading.length);
  const next = after.search(/\n#{1,6}\s/);
  return (next < 0 ? after : after.slice(0, next)).trim();
}

function drawingJson(md: string): string | null {
  const i = md.indexOf("## Drawing");
  if (i < 0) return null;
  const m = md.slice(i).match(/```[a-zA-Z-]*\n([\s\S]*?)\n```/);
  if (!m) return null;
  return (m[1] ?? "").replace(/^%%\s*/, "").trim();
}

interface ParsedDrawing {
  elements: unknown[];
  appState: Obj | null;
  files: Obj | null;
  text: string;
  compressed: boolean;
}

function parseJson(raw: string): ParsedDrawing {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw err.invalidInput("not a valid .excalidraw JSON drawing", {});
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    throw err.invalidInput("not an Excalidraw drawing object", {});
  const d = doc as Obj;
  const elements = Array.isArray(d.elements) ? (d.elements as unknown[]) : [];
  return {
    elements,
    appState: (d.appState as Obj) ?? null,
    files: (d.files as Obj) ?? null,
    text: textFromElements(elements),
    compressed: false,
  };
}

function parseMd(raw: string): ParsedDrawing {
  const text = sectionBody(raw, "## Text Elements");
  const body = drawingJson(raw);
  if (body) {
    try {
      const p = parseJson(body);
      return { ...p, text: p.text || text };
    } catch {
      /* compressed / unparseable -> text only */
    }
  }
  return { elements: [], appState: null, files: null, text, compressed: true };
}

function embeddedFiles(files: Obj | null): Array<{ id: string; mime_type: string | null }> {
  if (!files) return [];
  return Object.entries(files).map(([id, f]) => ({
    id,
    mime_type:
      f && typeof f === "object" && typeof (f as Obj).mimeType === "string"
        ? ((f as Obj).mimeType as string)
        : null,
  }));
}

function isPluginUnavailable(e: unknown): boolean {
  return (
    e instanceof ObsidianTcError && (e.code === "plugin_missing" || e.code === "plugin_unreachable")
  );
}

/** Pure-filesystem read of an Excalidraw drawing (no plugin). Shape matches the bridge result
 *  ({ elements, text, ... }) plus source:"filesystem" and compressed. */
function readFromDisk(root: string, rel: string, format: "elements" | "text" | "both"): Obj {
  const kind = excalidrawKind(rel);
  if (!kind)
    throw err.invalidInput("path must be a .excalidraw or .excalidraw.md file", { path: rel });
  const abs = resolveVaultPath(root, rel);
  const ex = noteExists(abs);
  if (!ex.exists || ex.type === "folder")
    throw err.noteNotFound("excalidraw drawing not found", { path: rel });
  const { raw, hash } = readNote(abs);
  const p = kind === "md" ? parseMd(raw) : parseJson(raw);
  const out: Obj = { source: "filesystem", compressed: p.compressed, content_hash: hash };
  if (format !== "text") {
    out.elements = p.elements;
    out.element_count = p.elements.length;
    out.embedded_files = embeddedFiles(p.files);
    out.app_state = p.appState;
  }
  if (format !== "elements") out.text = p.text;
  return out;
}

// THE-417: read_excalidraw has two arms — source="filesystem" (readFromDisk's own fields:
// compressed/content_hash always, elements/element_count/embedded_files/app_state when format is
// not "text", text when format is not "elements") and source="plugin" (the companion's arbitrary
// /excalidraw/read JSON, passthrough). readFromDisk builds its result into an `Obj`
// (Record<string, unknown>) via property assignment rather than an object literal, so TypeScript
// does not preserve per-arm literal shapes across the handler's three return statements — encoded
// as ONE object with optional fields (the ReflectOutput pattern) rather than a union that would not
// match the inferred return type, plus .passthrough() for the plugin arm's unknown extra keys.
const ReadExcalidrawOutput = z
  .object({
    vault: z.string(),
    path: z.string(),
    source: z.enum(["filesystem", "plugin"]),
    compressed: z.boolean().optional(),
    content_hash: z.string().optional(),
    elements: z.array(z.unknown()).optional(),
    element_count: z.number().int().optional(),
    embedded_files: z
      .array(z.object({ id: z.string(), mime_type: z.string().nullable() }))
      .optional(),
    app_state: z.record(z.string(), z.unknown()).nullable().optional(),
    text: z.string().optional(),
  })
  .passthrough();

// create_excalidraw / update_excalidraw both proxy the companion's /excalidraw/write response
// verbatim (`{ vault, path, ...result }`) — arbitrary plugin JSON, passthrough.
const CreateExcalidrawOutput = z.object({ vault: z.string(), path: z.string() }).passthrough();
const UpdateExcalidrawOutput = z.object({ vault: z.string(), path: z.string() }).passthrough();

export function buildExcalidrawTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "read_excalidraw",
      domain: "structured",
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description:
        "Read an Excalidraw drawing's raw elements and/or extracted text. source=plugin (default) proxies the live companion plugin; source=filesystem parses the .excalidraw / .excalidraw.md file on disk (works headlessly, no plugin); source=auto tries the plugin and falls back to the filesystem when it is unavailable (THE-202).",
      inputSchema: z
        .object({
          vault: VaultId,
          path: VaultPath,
          format: z.enum(["elements", "text", "both"]).default("both"),
          source: z.enum(["auto", "plugin", "filesystem"]).default("plugin"),
        })
        .strict(),
      outputSchema: ReadExcalidrawOutput,
      requiredScopes: ["read:excalidraw"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "read", rel, v.root);
        if (input.source === "filesystem")
          return { vault: v.id, path: rel, ...readFromDisk(v.root, rel, input.format) };
        try {
          const { client } = openBridge(deps, v.id, "excalidraw");
          const result = await client.request<Record<string, unknown>>({
            method: "POST",
            path: "/excalidraw/read",
            body: { path: rel, format: input.format },
            plugin: "excalidraw",
            timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
          });
          return { vault: v.id, path: rel, source: "plugin", ...result };
        } catch (e) {
          if (input.source === "auto" && isPluginUnavailable(e))
            return { vault: v.id, path: rel, ...readFromDisk(v.root, rel, input.format) };
          throw e;
        }
      },
    }),

    defineTool({
      name: "create_excalidraw",
      domain: "structured",
      vaultArg: "vault",
      pathAcl: (input) => [{ op: "write", path: input.path }],
      description:
        "Create a new Excalidraw note via the companion plugin. Overwriting an existing drawing requires confirmation.",
      inputSchema: z
        .object({
          vault: VaultId,
          path: VaultPath,
          template: z.enum(["blank", "compressed-json", "custom"]).optional(),
          elements: ElementArray.optional(),
          overwrite: z.boolean().default(false),
          // THE-824: advertised so a caller can discover the HITL confirmation parameter via
          // describe_capability — stripped off rawArgs into ctx.elicitToken before this schema
          // ever validates it (mcp/server.ts), so declaring it here changes nothing about dispatch.
          elicit_token: ElicitToken.optional(),
        })
        .strict(),
      outputSchema: CreateExcalidrawOutput,
      requiredScopes: ["write:excalidraw"],
      // THE-824: display-only — see ToolDefinition.conditionallyDestructive. The real gate stays
      // the requireConfirmation call below (input.overwrite === true); this only stops the wire
      // annotation from advertising destructive: false for a tool that CAN demand confirmation.
      conditionallyDestructive: true,
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "write", rel, v.root);
        requireConfirmation(ctx, "create_excalidraw", input, input.overwrite === true, {
          path: rel,
        });
        const { client } = openBridge(deps, v.id, "excalidraw");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/excalidraw/write",
          body: {
            path: rel,
            mode: "create",
            overwrite: input.overwrite,
            ...(input.template ? { template: input.template } : {}),
            ...(input.elements ? { elements: input.elements } : {}),
          },
          plugin: "excalidraw",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, path: rel, ...result };
      },
    }),

    defineTool({
      name: "update_excalidraw",
      domain: "structured",
      vaultArg: "vault",
      pathAcl: (input) => [{ op: "write", path: input.path }],
      description:
        "Add, remove, or update elements in an existing Excalidraw note via the companion plugin.",
      inputSchema: z
        .object({
          vault: VaultId,
          path: VaultPath,
          add_elements: ElementArray.optional(),
          remove_element_ids: z.array(z.string()).optional(),
          update_elements: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
          update_app_state: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
      outputSchema: UpdateExcalidrawOutput,
      requiredScopes: ["write:excalidraw"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "write", rel, v.root);
        const { client } = openBridge(deps, v.id, "excalidraw");
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/excalidraw/write",
          body: {
            path: rel,
            mode: "update",
            ...(input.add_elements ? { add_elements: input.add_elements } : {}),
            ...(input.remove_element_ids ? { remove_element_ids: input.remove_element_ids } : {}),
            ...(input.update_elements ? { update_elements: input.update_elements } : {}),
            ...(input.update_app_state ? { update_app_state: input.update_app_state } : {}),
          },
          plugin: "excalidraw",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        return { vault: v.id, path: rel, ...result };
      },
    }),
  ];
}
