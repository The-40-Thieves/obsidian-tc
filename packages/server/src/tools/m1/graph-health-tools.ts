// Domain — vault graph health + link recommendation (THE-375). Composites the existing link
// primitives (orphans, unresolved links, hubs) into one vault_health_score, adds cycle detection
// (find_link_cycles), and a graph-based link-recommendation pair (get_link_strength between two
// notes, suggest_links for a note). All read-only, embedding-free — a single link-graph pass over
// the readable note set (wikilinks/markdown links resolved via the shared vault index).
import { err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { type FolderAcl, globMatch } from "../../acl";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { readableRel } from "../../vault/acl-read-filter";
import { parseNote } from "../../vault/frontmatter";
import { buildVaultIndex, extractLinks, resolveTarget } from "../../vault/links";
import { readNote } from "../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import { defineTool } from "./define";
import type { M1Deps } from "./index";

function readableNotes(root: string, acl: FolderAcl | undefined): string[] {
  return walkVault(root, { extensions: [".md"] })
    .map((e) => e.relPath)
    .filter((rel) => readableRel(acl, rel));
}
function bodyOf(root: string, rel: string): string {
  return parseNote(readNote(resolveVaultPath(root, rel)).raw).body;
}
function isExternal(kind: string, target: string): boolean {
  return kind === "markdown" && /^[a-z]+:\/\//i.test(target);
}

// Frontmatter has the key with a non-empty value (non-empty string/array, or any present scalar).
function fmHas(fm: Record<string, unknown> | null, key: string): boolean {
  if (!fm || !(key in fm)) return false;
  const val = fm[key];
  if (val == null) return false;
  if (typeof val === "string") return val.trim().length > 0;
  if (Array.isArray(val)) return val.length > 0;
  return true;
}

interface Graph {
  notes: string[];
  out: Map<string, Set<string>>;
  inn: Map<string, Set<string>>;
  unresolved: number;
  links: number;
}

function buildLinkGraph(root: string, acl: FolderAcl | undefined): Graph {
  const notes = readableNotes(root, acl);
  const index = buildVaultIndex(notes);
  const out = new Map<string, Set<string>>();
  const inn = new Map<string, Set<string>>();
  for (const p of notes) {
    out.set(p, new Set());
    inn.set(p, new Set());
  }
  let unresolved = 0;
  let links = 0;
  for (const p of notes) {
    for (const l of extractLinks(bodyOf(root, p))) {
      if (l.inCodeblock) continue;
      if (isExternal(l.kind, l.target)) continue;
      if (l.target === "" || l.target.startsWith("#")) continue;
      links++;
      const r = resolveTarget(index, l.target);
      if (r.resolved && r.target_path && r.target_path !== p) {
        out.get(p)?.add(r.target_path);
        inn.get(r.target_path)?.add(p);
      } else if (!r.resolved) {
        unresolved++;
      }
    }
  }
  return { notes, out, inn, unresolved, links };
}

/** Directed-cycle enumeration (DFS back-edges). Bounded by `limit` cycles found. */
function findCycles(out: Map<string, Set<string>>, limit: number): string[][] {
  const state = new Map<string, number>(); // 0 unseen, 1 on-stack, 2 done
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (u: string): void => {
    if (cycles.length >= limit) return;
    state.set(u, 1);
    stack.push(u);
    for (const w of out.get(u) ?? []) {
      if (cycles.length >= limit) break;
      const s = state.get(w) ?? 0;
      if (s === 1) {
        const i = stack.lastIndexOf(w);
        if (i >= 0) cycles.push([...stack.slice(i), w]);
      } else if (s === 0) {
        visit(w);
      }
    }
    stack.pop();
    state.set(u, 2);
  };
  for (const n of out.keys()) {
    if (cycles.length >= limit) break;
    if ((state.get(n) ?? 0) === 0) visit(n);
  }
  return cycles;
}

function intersectSize(a: Set<string> | undefined, b: Set<string> | undefined): number {
  if (!a || !b) return 0;
  let n = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) n++;
  return n;
}

/** Undirected shortest-path hop count between two notes, or null if disconnected. */
function undirectedDistance(g: Graph, from: string, to: string): number | null {
  if (from === to) return 0;
  const seen = new Set<string>([from]);
  let frontier = [from];
  let dist = 0;
  while (frontier.length) {
    dist++;
    const next: string[] = [];
    for (const u of frontier) {
      const neighbors = new Set<string>([...(g.out.get(u) ?? []), ...(g.inn.get(u) ?? [])]);
      for (const w of neighbors) {
        if (w === to) return dist;
        if (!seen.has(w)) {
          seen.add(w);
          next.push(w);
        }
      }
    }
    frontier = next;
  }
  return null;
}

export function buildGraphHealthTools(deps: M1Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "vault_health_score",
      description:
        "Composite vault link-health score (0-100) with a breakdown: orphan count, unresolved-link count, hub density, and cycle count over the readable note graph.",
      inputSchema: z
        .object({
          vault: VaultId,
          hub_threshold: z.number().int().positive().max(10000).default(20),
        })
        .strict(),
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const g = buildLinkGraph(v.root, ctx.acl);
        const total = g.notes.length;
        const orphans = g.notes.filter((p) => (g.inn.get(p)?.size ?? 0) === 0).length;
        const hubs = g.notes.filter((p) => (g.inn.get(p)?.size ?? 0) >= input.hub_threshold).length;
        const cycles = findCycles(g.out, 100).length;
        const orphanRatio = total ? orphans / total : 0;
        const unresolvedRatio = g.links ? g.unresolved / g.links : 0;
        const hubRatio = total ? hubs / total : 0;
        const pen = {
          orphans: orphanRatio * 30,
          unresolved: Math.min(unresolvedRatio, 1) * 30,
          cycles: Math.min(cycles, 10) * 2,
          hubs: hubRatio * 20,
        };
        const score = Math.max(
          0,
          Math.round(100 - pen.orphans - pen.unresolved - pen.cycles - pen.hubs),
        );
        return {
          vault: v.id,
          score,
          total_notes: total,
          total_links: g.links,
          metrics: { orphans, unresolved_links: g.unresolved, hubs, cycles },
          breakdown: {
            orphan_penalty: Math.round(pen.orphans),
            unresolved_penalty: Math.round(pen.unresolved),
            cycle_penalty: Math.round(pen.cycles),
            hub_penalty: Math.round(pen.hubs),
          },
        };
      },
    }),

    defineTool({
      name: "find_link_cycles",
      description:
        "Detect circular internal-link chains (a -> b -> ... -> a) in the readable note graph. Returns up to `limit` cycles as ordered path lists.",
      inputSchema: z
        .object({ vault: VaultId, limit: z.number().int().positive().max(1000).default(50) })
        .strict(),
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const g = buildLinkGraph(v.root, ctx.acl);
        const cycles = findCycles(g.out, input.limit);
        return { vault: v.id, total: cycles.length, cycles };
      },
    }),

    defineTool({
      name: "get_link_strength",
      pathAcl: (input) => [
        { op: "read", path: input.from },
        { op: "read", path: input.to },
      ],
      description:
        "Score the connection strength (0-1) between two notes from the link graph: direct edge, co-citation (shared inbound sources), shared outbound neighbors, and undirected graph distance.",
      inputSchema: z.object({ vault: VaultId, from: VaultPath, to: VaultPath }).strict(),
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const from = normalizeVaultPath(input.from);
        const to = normalizeVaultPath(input.to);
        enforcePathAcl(ctx.acl, "read", from, v.root);
        enforcePathAcl(ctx.acl, "read", to, v.root);
        const g = buildLinkGraph(v.root, ctx.acl);
        if (!g.out.has(from)) throw err.noteNotFound("note not found", { path: from });
        if (!g.out.has(to)) throw err.noteNotFound("note not found", { path: to });
        const direct = (g.out.get(from)?.has(to) ?? false) || (g.out.get(to)?.has(from) ?? false);
        const coCitation = intersectSize(g.inn.get(from), g.inn.get(to));
        const sharedOut = intersectSize(g.out.get(from), g.out.get(to));
        const distance = undirectedDistance(g, from, to);
        let strength = 0;
        if (direct) strength += 0.5;
        strength += Math.min(coCitation, 5) * 0.06;
        strength += Math.min(sharedOut, 5) * 0.04;
        if (distance !== null && distance > 0) strength += Math.max(0, 0.3 - (distance - 1) * 0.1);
        strength = Math.min(1, Number(strength.toFixed(3)));
        return {
          vault: v.id,
          from,
          to,
          direct,
          co_citation: coCitation,
          shared_out_neighbors: sharedOut,
          distance,
          strength,
        };
      },
    }),

    defineTool({
      name: "suggest_links",
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description:
        "Suggest notes to link a given note to, from the link graph (co-citation with the note's inbound sources + 2-hop outbound neighbors), excluding notes it already links to. Graph-based (no embeddings).",
      inputSchema: z
        .object({
          vault: VaultId,
          path: VaultPath,
          limit: z.number().int().positive().max(200).default(20),
        })
        .strict(),
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const p = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "read", p, v.root);
        const g = buildLinkGraph(v.root, ctx.acl);
        if (!g.out.has(p)) throw err.noteNotFound("note not found", { path: p });
        const already = new Set<string>(g.out.get(p) ?? []);
        already.add(p);
        const score = new Map<string, { co_citation: number; two_hop: number }>();
        const bump = (c: string, key: "co_citation" | "two_hop"): void => {
          if (already.has(c)) return;
          const s = score.get(c) ?? { co_citation: 0, two_hop: 0 };
          s[key]++;
          score.set(c, s);
        };
        for (const nbr of g.out.get(p) ?? [])
          for (const c of g.out.get(nbr) ?? []) bump(c, "two_hop");
        for (const src of g.inn.get(p) ?? [])
          for (const c of g.out.get(src) ?? []) bump(c, "co_citation");
        const suggestions = [...score.entries()]
          .map(([path, s]) => ({
            path,
            score: Number((s.co_citation * 2 + s.two_hop).toFixed(2)),
            co_citation: s.co_citation,
            two_hop: s.two_hop,
          }))
          .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
          .slice(0, input.limit);
        return { vault: v.id, path: p, total: suggestions.length, suggestions };
      },
    }),

    defineTool({
      name: "audit_provenance",
      description:
        "Provenance audit: flag claim-bearing notes that lack a 'sources' frontmatter field (the evidence a note's claims rest on), and report coverage of sources/confidence/verified across the readable note set. Read-only. Excludes daily notes, templates, and index files by default; tune scope with include/exclude globs and the field name.",
      inputSchema: z
        .object({
          vault: VaultId,
          field: z.string().min(1).default("sources"),
          include: z.array(z.string()).max(64).optional(),
          exclude: z.array(z.string()).max(64).optional(),
          limit: z.number().int().positive().max(2000).default(100),
        })
        .strict(),
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const DEFAULT_EXCLUDE = [
          "01-daily/**",
          "_templates/**",
          "**/00-INDEX.md",
          "**/_*-Index.md",
          "**/*.excalidraw.md",
        ];
        const exclude = [...DEFAULT_EXCLUDE, ...(input.exclude ?? [])];
        const inScope = (rel: string): boolean => {
          if (input.include?.length && !input.include.some((g) => globMatch(g, rel))) return false;
          return !exclude.some((g) => globMatch(g, rel));
        };
        const notes = readableNotes(v.root, ctx.acl).filter(inScope);
        const field = input.field;
        const byFolder = new Map<string, { scanned: number; missing: number }>();
        const missing: string[] = [];
        let withField = 0;
        let withConfidence = 0;
        let withVerified = 0;
        for (const rel of notes) {
          const fm = parseNote(readNote(resolveVaultPath(v.root, rel)).raw).frontmatter;
          const top = rel.split("/")[0] ?? "";
          const folder = byFolder.get(top) ?? { scanned: 0, missing: 0 };
          folder.scanned++;
          if (fmHas(fm, field)) withField++;
          else {
            folder.missing++;
            missing.push(rel);
          }
          if (fmHas(fm, "confidence")) withConfidence++;
          if (fm != null && "verified" in fm) withVerified++;
          byFolder.set(top, folder);
        }
        const scanned = notes.length;
        const round = (n: number): number => Number(n.toFixed(3));
        return {
          vault: v.id,
          field,
          scanned,
          with_provenance: withField,
          missing_provenance: missing.length,
          coverage: scanned ? round(withField / scanned) : 1,
          confidence_coverage: scanned ? round(withConfidence / scanned) : 0,
          verified_coverage: scanned ? round(withVerified / scanned) : 0,
          by_folder: Object.fromEntries(
            [...byFolder.entries()]
              .sort((a, b) => b[1].missing - a[1].missing || a[0].localeCompare(b[0]))
              .map(([k, s]) => [k, s]),
          ),
          missing: missing.slice(0, input.limit),
          truncated: missing.length > input.limit,
        };
      },
    }),
  ];
}
