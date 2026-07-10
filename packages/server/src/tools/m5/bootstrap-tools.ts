// Domain 23 (session/workspace) — session bootstrap (THE-101). A server-side port of the
// client-only session-bootstrap skill, so any MCP client (Cursor, ChatGPT, Cline, Continue) —
// not just skill-enabled Claude — can triage its opening message and preload the right vault
// context. The routing table (deep-mode paths + a domain signal->path map) is a JUDGMENT value:
// it lives in server config (bootstrap.*), never baked into this public tree. The tool ships the
// mechanism (triage + read); the operator supplies the table. With none configured the tool
// degrades to lightweight (nothing matches, nothing loads).
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { parseNote } from "../../vault/frontmatter";
import { noteExists, readNote } from "../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import { bootstrapConfigFor, type M5Deps } from "./shared";

type BootstrapMode = "lightweight" | "standard" | "deep";

export function buildBootstrapTools(deps: M5Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "session_bootstrap",
      description:
        "Triage an opening session message (auto -> lightweight | standard | deep) and preload the matching vault context notes, so any MCP client gets session bootstrap, not only skill-enabled ones. Deep loads the configured deepPaths; standard loads the paths of every domain whose signals appear in the message; lightweight loads nothing. The routing table comes from server config (bootstrap.*); with none configured the tool degrades to lightweight. Read-only.",
      inputSchema: z
        .object({
          vault: VaultId,
          message: z.string().default(""),
          mode: z.enum(["auto", "lightweight", "standard", "deep"]).default("auto"),
        })
        .strict(),
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const cfg = bootstrapConfigFor(deps);
        const msg = input.message.toLowerCase();
        const matched = cfg.domains.filter((d) =>
          d.signals.some((s) => msg.includes(s.toLowerCase())),
        );
        const deepPhrase = cfg.deepPhrases.some((p) => msg.includes(p.toLowerCase()));

        // Triage (skill parity): explicit mode wins; else a catch-up phrase or 3+ domain matches
        // -> deep, a single domain match -> standard, nothing -> lightweight.
        let mode: BootstrapMode;
        if (input.mode !== "auto") mode = input.mode;
        else if (deepPhrase || matched.length >= 3) mode = "deep";
        else if (matched.length >= 1) mode = "standard";
        else mode = "lightweight";

        let candidates: string[];
        if (mode === "deep") candidates = cfg.deepPaths;
        else if (mode === "standard") candidates = matched.flatMap((d) => d.paths);
        else candidates = [];

        // Dedupe preserving first-seen order, then cap at maxPaths.
        const seen = new Set<string>();
        const unique: string[] = [];
        for (const p of candidates) {
          if (!seen.has(p)) {
            seen.add(p);
            unique.push(p);
          }
        }
        const truncated = unique.length > cfg.maxPaths;
        const selected = unique.slice(0, cfg.maxPaths);

        const loaded: Array<Record<string, unknown>> = [];
        const skipped: Array<{ path: string; reason: string }> = [];
        for (const p of selected) {
          const rel = normalizeVaultPath(p);
          try {
            // A denied/missing path degrades to a skipped entry rather than failing the whole
            // bootstrap: a partial context load is the correct behavior for session open.
            enforcePathAcl(ctx.acl, "read", rel, v.root);
            const abs = resolveVaultPath(v.root, rel);
            const ex = noteExists(abs);
            if (!ex.exists || ex.type === "folder") {
              skipped.push({ path: rel, reason: "not_found" });
              continue;
            }
            const { raw, hash } = readNote(abs);
            const parsed = parseNote(raw);
            loaded.push({
              path: rel,
              content: raw,
              frontmatter: parsed.frontmatter,
              content_hash: hash,
            });
          } catch (e) {
            skipped.push({ path: rel, reason: (e as { code?: string }).code ?? "error" });
          }
        }

        return {
          vault: v.id,
          mode,
          matched_domains: matched.map((d) => d.name),
          loaded,
          skipped,
          truncated,
        };
      },
    }),
  ];
}
