// Domain — vault graph health + link recommendation (THE-375). Composites the existing link
// primitives (orphans, unresolved links, hubs) into one vault_health_score, adds cycle detection
// (find_link_cycles), and a graph-based link-recommendation pair (get_link_strength between two
// notes, suggest_links for a note). All read-only, embedding-free — a single link-graph pass over
// the readable note set (wikilinks/markdown links resolved via the shared vault index).
import { err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { FolderAcl } from "../../acl";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { buildVaultIndex, resolveTarget } from "../../vault/links";
import { normalizeVaultPath } from "../../vault/paths";
import { ResponseFormatInput, resolveResponseFormat } from "../response-format";
import { ScanWarnings, scanWarningsShape } from "../scan-warnings";
import { isExternal, linksOf, readableNotes, scanProvenance } from "../wiki-scan";
import { defineTool } from "./define";
import type { M1Deps } from "./shared";

interface Graph {
  notes: string[];
  out: Map<string, Set<string>>;
  inn: Map<string, Set<string>>;
  unresolved: number;
  links: number;
  /** Notes whose frontmatter YAML did not parse (their bodies were still scanned). */
  warnings: ScanWarnings;
}

function buildLinkGraph(
  root: string,
  acl: FolderAcl | undefined,
  grantedScopes: Iterable<string>,
): Graph {
  const notes = readableNotes(root, acl, grantedScopes);
  const index = buildVaultIndex(notes);
  const out = new Map<string, Set<string>>();
  const inn = new Map<string, Set<string>>();
  for (const p of notes) {
    out.set(p, new Set());
    inn.set(p, new Set());
  }
  let unresolved = 0;
  let links = 0;
  const warnings = new ScanWarnings();
  for (const p of notes) {
    for (const l of linksOf(root, p, warnings)) {
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
  return { notes, out, inn, unresolved, links, warnings };
}

/** Directed-cycle enumeration (DFS back-edges). Bounded by `limit` cycles reported; a cycle of more
 *  than `maxLength` links is not reported (a dense vault's DFS closes cycles hundreds of notes long,
 *  which is a page-sized answer to a question nobody asked) and is counted in `skippedLonger`. */
function findCycles(
  out: Map<string, Set<string>>,
  limit: number,
  maxLength: number,
): { cycles: string[][]; skippedLonger: number } {
  let skippedLonger = 0;
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
        if (i >= 0) {
          if (stack.length - i > maxLength) skippedLonger++;
          else cycles.push([...stack.slice(i), w]);
        }
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
  return { cycles, skippedLonger };
}

function intersectSize(a: Set<string> | undefined, b: Set<string> | undefined): number {
  if (!a || !b) return 0;
  let n = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) n++;
  return n;
}

// ---------------------------------------------------------------------------------------------
// THE-417 Phase 1: declared output contracts, written from the RETURN STATEMENTS below. Every
// tool here returns exactly one shape (no degradation/union arms), so these are plain objects.
// ---------------------------------------------------------------------------------------------

const VaultHealthScoreOutput = z.object({
  ...scanWarningsShape,
  vault: z.string(),
  score: z.number(),
  total_notes: z.number(),
  total_links: z.number(),
  metrics: z.object({
    orphans: z.number(),
    unresolved_links: z.number(),
    hubs: z.number(),
    cycles: z.number(),
  }),
  breakdown: z.object({
    orphan_penalty: z.number(),
    unresolved_penalty: z.number(),
    cycle_penalty: z.number(),
    hub_penalty: z.number(),
  }),
});

// GH #1027: `response_format=concise` drops `total_links` and the per-penalty `breakdown` (the score
// and the four metrics it is computed from stay).
const ConciseableVaultHealthScoreOutput = VaultHealthScoreOutput.partial({
  total_links: true,
  breakdown: true,
});

const FindLinkCyclesOutput = z.object({
  ...scanWarningsShape,
  vault: z.string(),
  total: z.number(),
  cycles: z.array(z.array(z.string())),
  /** Cycles found but not reported because they run longer than `max_length` links. */
  skipped_longer: z.number().int(),
});

const GetLinkStrengthOutput = z.object({
  ...scanWarningsShape,
  vault: z.string(),
  from: z.string(),
  to: z.string(),
  direct: z.boolean(),
  co_citation: z.number(),
  shared_out_neighbors: z.number(),
  distance: z.number().nullable(),
  strength: z.number(),
});

const SuggestLinkRow = z.object({
  path: z.string(),
  score: z.number(),
  co_citation: z.number(),
  two_hop: z.number(),
});

const SuggestLinksOutput = z.object({
  ...scanWarningsShape,
  vault: z.string(),
  path: z.string(),
  total: z.number(),
  suggestions: z.array(SuggestLinkRow),
});

// GH #1027: `response_format=concise` keeps `{path, score}` per suggestion and drops the two score
// components, the `path` echo and `total` (the length of `suggestions`).
const ConciseableSuggestLinksOutput = SuggestLinksOutput.extend({
  path: z.string().optional(),
  total: z.number().optional(),
  suggestions: z.array(SuggestLinkRow.partial({ co_citation: true, two_hop: true })),
});

const AuditProvenanceOutput = z.object({
  ...scanWarningsShape,
  vault: z.string(),
  field: z.string(),
  scanned: z.number(),
  with_provenance: z.number(),
  missing_provenance: z.number(),
  coverage: z.number(),
  confidence_coverage: z.number(),
  verified_coverage: z.number(),
  // Keyed by top-level folder name — dynamic, hence z.record rather than a fixed shape.
  by_folder: z.record(z.string(), z.object({ scanned: z.number(), missing: z.number() })),
  missing: z.array(z.string()),
  truncated: z.boolean(),
});

// GH #1027: `response_format=concise` drops the `field` echo, `with_provenance` (scanned minus
// missing) and the `by_folder` breakdown. The coverage ratios, the missing list and `truncated` stay.
const ConciseableAuditProvenanceOutput = AuditProvenanceOutput.partial({
  field: true,
  with_provenance: true,
  by_folder: true,
});

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
      domain: "links",
      description:
        "Composite vault link-health score (0-100) with a breakdown: orphan count, unresolved-link count, hub density, and cycle count over the readable note graph. response_format=concise drops total_links and the per-penalty breakdown. Domain: links.",
      inputSchema: z
        .object({
          vault: VaultId,
          hub_threshold: z.number().int().positive().max(10000).default(20),
          ...ResponseFormatInput,
        })
        .strict(),
      outputSchema: ConciseableVaultHealthScoreOutput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const g = buildLinkGraph(v.root, ctx.acl, ctx.grantedScopes);
        const total = g.notes.length;
        const orphans = g.notes.filter((p) => (g.inn.get(p)?.size ?? 0) === 0).length;
        const hubs = g.notes.filter((p) => (g.inn.get(p)?.size ?? 0) >= input.hub_threshold).length;
        const cycles = findCycles(g.out, 100, Number.POSITIVE_INFINITY).cycles.length;
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
        if (resolveResponseFormat(input, deps.responseFormat) === "concise")
          return {
            ...g.warnings.out(),
            vault: v.id,
            score,
            total_notes: total,
            metrics: { orphans, unresolved_links: g.unresolved, hubs, cycles },
          };
        return {
          ...g.warnings.out(),
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
      domain: "links",
      description:
        "Detect circular internal-link chains (a -> b -> ... -> a) in the readable note graph. Returns up to `limit` cycles as ordered path lists.",
      inputSchema: z
        .object({
          vault: VaultId,
          limit: z.number().int().positive().max(1000).default(10),
          max_length: z.number().int().min(2).max(1000).default(10),
        })
        .strict(),
      outputSchema: FindLinkCyclesOutput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const g = buildLinkGraph(v.root, ctx.acl, ctx.grantedScopes);
        const { cycles, skippedLonger } = findCycles(g.out, input.limit, input.max_length);
        return {
          ...g.warnings.out(),
          vault: v.id,
          total: cycles.length,
          cycles,
          skipped_longer: skippedLonger,
        };
      },
    }),

    defineTool({
      name: "get_link_strength",
      domain: "links",
      pathAcl: (input) => [
        { op: "read", path: input.from },
        { op: "read", path: input.to },
      ],
      description:
        "Score the connection strength (0-1) between two notes from the link graph: direct edge, co-citation (shared inbound sources), shared outbound neighbors, and undirected graph distance.",
      inputSchema: z.object({ vault: VaultId, from: VaultPath, to: VaultPath }).strict(),
      outputSchema: GetLinkStrengthOutput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const from = normalizeVaultPath(input.from);
        const to = normalizeVaultPath(input.to);
        enforcePathAcl(ctx.acl, "read", from, v.root, ctx.grantedScopes);
        enforcePathAcl(ctx.acl, "read", to, v.root, ctx.grantedScopes);
        const g = buildLinkGraph(v.root, ctx.acl, ctx.grantedScopes);
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
          ...g.warnings.out(),
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
      domain: "links",
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description:
        "Suggest notes to link a given note to, from the link graph (co-citation with the note's inbound sources + 2-hop outbound neighbors), excluding notes it already links to. Graph-based (no embeddings). response_format=concise returns {path, score} per suggestion without the score components, the path echo and total.",
      inputSchema: z
        .object({
          vault: VaultId,
          path: VaultPath,
          limit: z.number().int().positive().max(200).default(20),
          ...ResponseFormatInput,
        })
        .strict(),
      outputSchema: ConciseableSuggestLinksOutput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const p = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "read", p, v.root, ctx.grantedScopes);
        const g = buildLinkGraph(v.root, ctx.acl, ctx.grantedScopes);
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
        if (resolveResponseFormat(input, deps.responseFormat) === "concise")
          return {
            ...g.warnings.out(),
            vault: v.id,
            suggestions: suggestions.map(({ path, score }) => ({ path, score })),
          };
        return {
          ...g.warnings.out(),
          vault: v.id,
          path: p,
          total: suggestions.length,
          suggestions,
        };
      },
    }),

    defineTool({
      name: "audit_provenance",
      domain: "knowledge",
      description:
        "Provenance audit: flag claim-bearing notes that lack a 'sources' frontmatter field (the evidence a note's claims rest on), and report coverage of sources/confidence/verified across the readable note set. Read-only. Excludes daily notes, templates, and index files by default; tune scope with include/exclude globs and the field name. response_format=concise drops the field echo, with_provenance and the by_folder breakdown.",
      inputSchema: z
        .object({
          vault: VaultId,
          field: z.string().min(1).default("sources"),
          include: z.array(z.string()).max(64).optional(),
          exclude: z.array(z.string()).max(64).optional(),
          limit: z.number().int().positive().max(2000).default(100),
          ...ResponseFormatInput,
        })
        .strict(),
      outputSchema: ConciseableAuditProvenanceOutput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const warnings = new ScanWarnings();
        const scan = scanProvenance(
          {
            root: v.root,
            acl: ctx.acl,
            grantedScopes: ctx.grantedScopes,
            wikiFolder: v.wikiFolder,
            wikiFolders: v.wikiFolders,
            rawFolders: v.rawFolders,
          },
          warnings,
          { field: input.field, include: input.include, exclude: input.exclude },
        );
        const { scanned, withField, withConfidence, withVerified, missing, byFolder } = scan;
        const field = input.field;
        const round = (n: number): number => Number(n.toFixed(3));
        if (resolveResponseFormat(input, deps.responseFormat) === "concise")
          return {
            ...warnings.out(),
            vault: v.id,
            scanned,
            missing_provenance: missing.length,
            coverage: scanned ? round(withField / scanned) : 1,
            confidence_coverage: scanned ? round(withConfidence / scanned) : 0,
            verified_coverage: scanned ? round(withVerified / scanned) : 0,
            missing: missing.slice(0, input.limit),
            truncated: missing.length > input.limit,
          };
        return {
          ...warnings.out(),
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
