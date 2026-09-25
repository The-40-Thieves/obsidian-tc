// THE-1124 — turn a ParsedSource into vault writes, or a dry-run preview of the same. Every
// mutation goes through `dispatch` — the caller's bound `registry.dispatch(name, input, ctx)`
// (cli/commands/memory-import.ts, mirroring cli/commands/prefetch.ts) — the SAME create_entity /
// add_observation / link_entities / update_frontmatter tools an MCP client calls, so ACL
// enforcement and the audit_events row (registry.dispatch's recordOutcome) are never
// bypassed. There is no direct-file-write path here at all: the memory-note frontmatter is
// server-computed by create_entity (memory-tools.ts's own header: "not input-derivable"), so
// provenance (imported_from/source_path/imported_at) is layered on with a SECOND sanctioned
// call, update_frontmatter (operation: "merge") — which materialize.ts's round-trip discipline
// then PRESERVES on every subsequent re-materialization (add_observation, link_entities), the
// same as any other unknown frontmatter key.
//
// Idempotency keys on source_path, not on (type, name) alone: a re-run that finds an entity
// already at that (type, name) reads its `source_path` frontmatter back (read_frontmatter) before
// touching it. A match means "this is the same import, continue" (observations/relations are
// then diffed against what's already there — add_observation has no dedup of its own, so this
// layer provides it; link_entities is already idempotent by construction). A mismatch, or no
// verifiable provenance at all (unmaterialized entity, or one nothing has ever imported before),
// is refused as a COLLISION rather than silently adopted — [[feedback-delete-path-as-strict-as-write-path]]:
// a path that can overwrite someone else's data must be at least as strict as the path that wrote it.
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import type { ImportAdapterName, ParsedEntity, ParsedRelation, SkippedFile } from "./types";

export type Dispatch = (name: string, input: Record<string, unknown>) => Promise<ToolResult>;

export interface RelationOutcome extends ParsedRelation {
  status: "created" | "already-exists" | "planned" | "skipped";
  reason?: string;
}

export interface EntityOutcome {
  sourcePath: string;
  entityType: string;
  name: string;
  action: "create" | "exists" | "collision" | "error";
  reason?: string;
  observationsToAdd: number;
  observationsAlready: number;
  relations: RelationOutcome[];
}

export interface ImportReport {
  adapter: ImportAdapterName;
  applied: boolean;
  entities: EntityOutcome[];
  /** Parse-time skips (walk refusals, malformed frontmatter, the index file) — distinct from a
   *  per-entity apply-time collision/error, which lives on that entity's EntityOutcome instead. */
  skipped: SkippedFile[];
}

function errMessage(r: ToolResult): string {
  return !r.ok ? r.error.message : "";
}

function isAlreadyExists(r: ToolResult): boolean {
  return !r.ok && r.error.code === "invalid_input" && /already exists/i.test(r.error.message);
}

interface ExistingEntity {
  entityId: string;
  vaultPath: string | null;
  observations: Set<string>;
  outRelations: Set<string>; // `${relation_type}\u0000${target_name}`
}

async function readExistingEntity(
  dispatch: Dispatch,
  vault: string,
  entityType: string,
  name: string,
): Promise<{ found: false } | { found: true; entity: ExistingEntity }> {
  const r = await dispatch("get_entity", { vault, type: entityType, name });
  if (!r.ok) return { found: false };
  const d = r.data as {
    entity_id: string;
    vault_path: string | null;
    observations: string[];
    relations: { target_name: string; relation_type: string; direction: "out" | "in" }[];
  };
  return {
    found: true,
    entity: {
      entityId: d.entity_id,
      vaultPath: d.vault_path,
      observations: new Set(d.observations),
      outRelations: new Set(
        d.relations
          .filter((rel) => rel.direction === "out")
          .map((rel) => `${rel.relation_type}\u0000${rel.target_name}`),
      ),
    },
  };
}

/** `undefined` (not false) when provenance genuinely cannot be established either way — a
 *  read_frontmatter failure or an entity with no materialized note — so the caller can refuse the
 *  ambiguous case rather than read "false" as a confident mismatch. */
async function sourcePathMatches(
  dispatch: Dispatch,
  vault: string,
  vaultPath: string | null,
  sourcePath: string,
): Promise<boolean | undefined> {
  if (!vaultPath) return undefined;
  const r = await dispatch("read_frontmatter", { vault, path: vaultPath });
  if (!r.ok) return undefined;
  const fm = (r.data as { frontmatter: Record<string, unknown> | null }).frontmatter;
  const existing = fm?.source_path;
  if (typeof existing !== "string") return undefined;
  return existing === sourcePath;
}

async function resolveEntity(
  dispatch: Dispatch,
  vault: string,
  adapter: ImportAdapterName,
  e: ParsedEntity,
  applied: boolean,
  importedAt: string,
): Promise<{
  outcome: EntityOutcome;
  entityId: string | undefined;
  existingObservations: Set<string>;
  existingOutRelations: Set<string>;
}> {
  const found = await readExistingEntity(dispatch, vault, e.entityType, e.name);
  if (found.found) {
    const match = await sourcePathMatches(dispatch, vault, found.entity.vaultPath, e.sourcePath);
    if (match !== true) {
      return {
        outcome: {
          sourcePath: e.sourcePath,
          entityType: e.entityType,
          name: e.name,
          action: "collision",
          reason:
            match === false
              ? `entity ${e.entityType}/${e.name} already exists with a different source_path`
              : `entity ${e.entityType}/${e.name} already exists with no verifiable import provenance`,
          observationsToAdd: 0,
          observationsAlready: 0,
          relations: [],
        },
        entityId: undefined,
        existingObservations: new Set(),
        existingOutRelations: new Set(),
      };
    }
    return {
      outcome: {
        sourcePath: e.sourcePath,
        entityType: e.entityType,
        name: e.name,
        action: "exists",
        observationsToAdd: 0,
        observationsAlready: 0,
        relations: [],
      },
      entityId: found.entity.entityId,
      existingObservations: found.entity.observations,
      existingOutRelations: found.entity.outRelations,
    };
  }
  if (!applied) {
    return {
      outcome: {
        sourcePath: e.sourcePath,
        entityType: e.entityType,
        name: e.name,
        action: "create",
        observationsToAdd: 0,
        observationsAlready: 0,
        relations: [],
      },
      entityId: undefined,
      existingObservations: new Set(),
      existingOutRelations: new Set(),
    };
  }
  const createRes = await dispatch("create_entity", {
    vault,
    type: e.entityType,
    name: e.name,
    materialize: true,
  });
  if (!createRes.ok && isAlreadyExists(createRes)) {
    // Lost a create-vs-create race (or a prior partial run committed the row but not the
    // frontmatter merge below) — re-resolve as "exists" instead of failing the whole entity.
    const retry = await readExistingEntity(dispatch, vault, e.entityType, e.name);
    if (retry.found) {
      return {
        outcome: {
          sourcePath: e.sourcePath,
          entityType: e.entityType,
          name: e.name,
          action: "exists",
          observationsToAdd: 0,
          observationsAlready: 0,
          relations: [],
        },
        entityId: retry.entity.entityId,
        existingObservations: retry.entity.observations,
        existingOutRelations: retry.entity.outRelations,
      };
    }
  }
  if (!createRes.ok) {
    return {
      outcome: {
        sourcePath: e.sourcePath,
        entityType: e.entityType,
        name: e.name,
        action: "error",
        reason: errMessage(createRes),
        observationsToAdd: 0,
        observationsAlready: 0,
        relations: [],
      },
      entityId: undefined,
      existingObservations: new Set(),
      existingOutRelations: new Set(),
    };
  }
  const created = createRes.data as { entity_id: string; vault_path: string | null };
  if (created.vault_path) {
    await dispatch("update_frontmatter", {
      vault,
      path: created.vault_path,
      operation: "merge",
      properties: { imported_from: adapter, source_path: e.sourcePath, imported_at: importedAt },
    });
  }
  return {
    outcome: {
      sourcePath: e.sourcePath,
      entityType: e.entityType,
      name: e.name,
      action: "create",
      observationsToAdd: 0,
      observationsAlready: 0,
      relations: [],
    },
    entityId: created.entity_id,
    existingObservations: new Set(),
    existingOutRelations: new Set(),
  };
}

export interface ApplyImportOptions {
  vault: string;
  adapter: ImportAdapterName;
  dispatch: Dispatch;
  applied: boolean;
  /** ISO 8601 instant stamped as `imported_at`; injectable for deterministic tests. */
  now?: () => string;
}

export async function applyImport(
  parsed: { entities: ParsedEntity[]; skipped: SkippedFile[] },
  opts: ApplyImportOptions,
): Promise<ImportReport> {
  const importedAt = (opts.now ?? (() => new Date().toISOString()))();
  const entityOutcomes: EntityOutcome[] = [];
  // Every name this batch successfully resolved (created OR already-existing), independent of
  // dry-run — a dry-run "create" has no real id yet but IS a valid relation target for the
  // PREVIEW (the entity would exist by the time --apply runs the relation pass). `batchIds` holds
  // the real id, only ever populated when one exists (always for "exists"; for "create" only
  // once --apply actually ran create_entity).
  const batchNames = new Set<string>();
  const batchIds = new Map<string, string>();
  const perEntityState = new Map<
    string,
    { existingObservations: Set<string>; existingOutRelations: Set<string> }
  >();

  for (const e of parsed.entities) {
    const { outcome, entityId, existingObservations, existingOutRelations } = await resolveEntity(
      opts.dispatch,
      opts.vault,
      opts.adapter,
      e,
      opts.applied,
      importedAt,
    );
    if (outcome.action === "collision" || outcome.action === "error") {
      entityOutcomes.push(outcome);
      continue;
    }
    const toAdd = e.observations.filter((o) => !existingObservations.has(o));
    outcome.observationsToAdd = toAdd.length;
    outcome.observationsAlready = e.observations.length - toAdd.length;
    if (opts.applied && entityId) {
      for (const o of toAdd)
        await opts.dispatch("add_observation", {
          vault: opts.vault,
          entity_id: entityId,
          observation: o,
        });
    }
    batchNames.add(e.name);
    if (entityId) batchIds.set(e.name, entityId);
    perEntityState.set(e.sourcePath, { existingObservations, existingOutRelations });
    entityOutcomes.push(outcome);
  }

  // Second pass: relations. A target may be created earlier OR LATER in this same batch
  // (basic-memory/claude-code notes reference each other in either order), so relation
  // resolution runs only after every entity above has been created/resolved.
  for (let i = 0; i < parsed.entities.length; i++) {
    const e = parsed.entities[i];
    const outcome = entityOutcomes[i];
    if (!e || !outcome || outcome.action === "collision" || outcome.action === "error") continue;
    const sourceId = batchIds.get(e.name);
    const existingOutRelations =
      perEntityState.get(e.sourcePath)?.existingOutRelations ?? new Set<string>();
    for (const rel of e.relations) {
      const already = existingOutRelations.has(`${rel.relationType}\u0000${rel.targetName}`);
      if (already) {
        outcome.relations.push({ ...rel, status: "already-exists" });
        continue;
      }
      // A target is "known" for preview purposes as soon as ANY entity in this batch resolved
      // to that name — including a dry-run "create" with no real id yet (it WOULD exist by the
      // time --apply runs). Only a name this batch never touched needs a live vault lookup.
      let targetId = batchIds.get(rel.targetName);
      if (!batchNames.has(rel.targetName)) {
        const found = await opts.dispatch("get_entity", {
          vault: opts.vault,
          name: rel.targetName,
        });
        if (found.ok) {
          targetId = (found.data as { entity_id: string }).entity_id;
        } else if (found.error.code === "invalid_input" && /ambiguous/i.test(found.error.message)) {
          outcome.relations.push({
            ...rel,
            status: "skipped",
            reason: `relation target name is ambiguous in the vault: ${rel.targetName}`,
          });
          continue;
        } else {
          outcome.relations.push({
            ...rel,
            status: "skipped",
            reason: `relation target not found: ${rel.targetName}`,
          });
          continue;
        }
      }
      if (!opts.applied) {
        outcome.relations.push({ ...rel, status: "planned" });
        continue;
      }
      if (!sourceId || !targetId) {
        outcome.relations.push({
          ...rel,
          status: "skipped",
          reason: !sourceId
            ? "source entity was not created (see its own error)"
            : "relation target entity was not created (see its own error)",
        });
        continue;
      }
      const linked = await opts.dispatch("link_entities", {
        vault: opts.vault,
        source_id: sourceId,
        target_id: targetId,
        relation_type: rel.relationType,
      });
      outcome.relations.push({
        ...rel,
        status: linked.ok ? "created" : "skipped",
        ...(linked.ok ? {} : { reason: errMessage(linked) }),
      });
    }
  }

  return {
    adapter: opts.adapter,
    applied: opts.applied,
    entities: entityOutcomes,
    skipped: parsed.skipped,
  };
}
