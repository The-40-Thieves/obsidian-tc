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
// same as any other unknown frontmatter key. Every observation a NEW entity carries is passed to
// create_entity's own `observations` array at creation time (one call, one render) rather than a
// separate add_observation per fact — avoids create-then-N-appends' O(n) re-materializations for
// n observations (review finding: 1,000 observations measured at 7.8s, 4,000 at 43s the old way).
//
// Idempotency keys on source_path, not on (type, name) alone: a re-run that finds an entity
// already at that (type, name) reads its `source_path` frontmatter back (read_frontmatter) before
// touching it. A match means "this is the same import, continue" (observations/relations are
// then diffed against what's already there — add_observation has no dedup of its own, so this
// layer provides it; link_entities is already idempotent by construction). A mismatch, or no
// verifiable provenance at all (unmaterialized entity, or one nothing has ever imported before),
// is refused as a COLLISION rather than silently adopted — [[feedback-delete-path-as-strict-as-write-path]]:
// a path that can overwrite someone else's data must be at least as strict as the path that wrote it.
// The one exception is `--resume`: an entity with a row and ZERO observations and unverifiable
// provenance is exactly what a run interrupted between create_entity and its update_frontmatter
// call leaves behind, so `--resume` (never the default) treats it as ours and retries the
// frontmatter write, rather than requiring the operator to hand-delete the orphaned row.
//
// Every dispatch result is checked. A failed add_observation, update_frontmatter, or link_entities
// call is recorded as an error against that entity/relation and stops further work on it — none of
// them are fire-and-forget (review finding: a discarded failure used to report success with the
// entity then permanently unresumable, having "no verifiable import provenance").
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { renderEntityNote } from "../memory/materialize";
import { parseNote } from "../vault/frontmatter";
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
  action: "create" | "exists" | "resumed" | "collision" | "error";
  reason?: string;
  observationsToAdd: number;
  observationsAlready: number;
  relations: RelationOutcome[];
}

export interface ImportReport {
  adapter: ImportAdapterName;
  applied: boolean;
  entities: EntityOutcome[];
  /** Parse-time skips (walk refusals, malformed frontmatter, the index file, sanitized-name
   *  collisions caught at plan time) — distinct from a per-entity apply-time collision/error,
   *  which lives on that entity's EntityOutcome instead. */
  skipped: SkippedFile[];
}

function errMessage(r: ToolResult): string {
  return !r.ok ? r.error.message : "";
}

function isAlreadyExists(r: ToolResult): boolean {
  return !r.ok && r.error.code === "invalid_input" && /already exists/i.test(r.error.message);
}

/**
 * `--resume` safety check (review finding): a note's zero-DB-observations state is not proof its
 * BODY was never touched — a human can edit the file directly. Compares the note's actual body
 * against the byte-exact body a freshly-created, zero-observation, zero-relation entity would
 * render (the SAME renderEntityNote the materializer itself uses, so this can never drift from
 * what "empty" really looks like) rather than a heuristic. `false` on any read failure — an
 * unreadable note is never treated as safely resumable.
 */
async function noteBodyIsEmptyScaffold(
  dispatch: Dispatch,
  vault: string,
  vaultPath: string,
  entityId: string,
  entityType: string,
  name: string,
): Promise<boolean> {
  const r = await dispatch("read_note", { vault, path: vaultPath });
  if (!r.ok) return false;
  const actualBody = (r.data as { body: string }).body;
  const scaffold = renderEntityNote({
    id: entityId,
    entityType,
    name,
    status: "active",
    observations: [],
    relations: [],
  });
  const scaffoldBody = parseNote(scaffold).body;
  return actualBody === scaffoldBody;
}

async function setProvenance(
  dispatch: Dispatch,
  vault: string,
  adapter: ImportAdapterName,
  vaultPath: string,
  sourcePath: string,
  importedAt: string,
): Promise<ToolResult> {
  return dispatch("update_frontmatter", {
    vault,
    path: vaultPath,
    operation: "merge",
    properties: { imported_from: adapter, source_path: sourcePath, imported_at: importedAt },
  });
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

function baseOutcome(e: ParsedEntity): EntityOutcome {
  return {
    sourcePath: e.sourcePath,
    entityType: e.entityType,
    name: e.name,
    action: "create",
    observationsToAdd: 0,
    observationsAlready: 0,
    relations: [],
  };
}

interface ResolveResult {
  outcome: EntityOutcome;
  /** Set only when the entity is usable as a relation source/target THIS run — absent for
   *  collision/error, so batchIds/batchNames (applyImport's relation-phase bookkeeping) can gate
   *  on presence alone rather than re-checking `outcome.action`. */
  entityId?: string;
  existingObservations: Set<string>;
  existingOutRelations: Set<string>;
}

async function resolveEntity(
  dispatch: Dispatch,
  vault: string,
  adapter: ImportAdapterName,
  e: ParsedEntity,
  applied: boolean,
  resume: boolean,
  importedAt: string,
): Promise<ResolveResult> {
  const found = await readExistingEntity(dispatch, vault, e.entityType, e.name);
  if (found.found) {
    const match = await sourcePathMatches(dispatch, vault, found.entity.vaultPath, e.sourcePath);
    if (match === true) {
      return {
        outcome: { ...baseOutcome(e), action: "exists" },
        entityId: found.entity.entityId,
        existingObservations: found.entity.observations,
        existingOutRelations: found.entity.outRelations,
      };
    }
    // `--resume`: only for the exact shape an interrupted first run leaves — the row exists, no
    // observations were ever added (create_entity's initial batch never landed, or this run
    // itself is what's about to add them for the first time), and provenance is unverifiable
    // (never a CONFIRMED mismatch — `match === false` is a real foreign entity, resume never
    // overrides that). Review finding: zero DB observations is NOT enough on its own — a human
    // can edit the materialized NOTE FILE directly (add prose below the rendered scaffold)
    // without ever calling add_observation, so the db-side count reads as "untouched" while the
    // file genuinely carries content that must not be silently discarded. Compare the note's
    // actual body against what a freshly-created, zero-observation entity's body would render as
    // (byte for byte, via the SAME renderEntityNote the materializer itself uses) rather than a
    // heuristic like "short" or "no prose keywords" — an empty scaffold is the one shape this can
    // verify exactly.
    let resumable = resume && match === undefined && found.entity.observations.size === 0;
    if (resumable && found.entity.vaultPath) {
      resumable = await noteBodyIsEmptyScaffold(
        dispatch,
        vault,
        found.entity.vaultPath,
        found.entity.entityId,
        e.entityType,
        e.name,
      );
    }
    if (resumable) {
      if (applied && found.entity.vaultPath) {
        const fm = await setProvenance(
          dispatch,
          vault,
          adapter,
          found.entity.vaultPath,
          e.sourcePath,
          importedAt,
        );
        if (!fm.ok) {
          return {
            outcome: {
              ...baseOutcome(e),
              action: "error",
              reason: `--resume: could not set provenance frontmatter: ${errMessage(fm)}`,
            },
            existingObservations: new Set(),
            existingOutRelations: new Set(),
          };
        }
      }
      return {
        outcome: { ...baseOutcome(e), action: "resumed" },
        entityId: found.entity.entityId,
        existingObservations: found.entity.observations,
        existingOutRelations: found.entity.outRelations,
      };
    }
    return {
      outcome: {
        ...baseOutcome(e),
        action: "collision",
        reason:
          match === false
            ? `entity ${e.entityType}/${e.name} already exists with a different source_path`
            : `entity ${e.entityType}/${e.name} already exists with no verifiable import provenance` +
              (resume
                ? " (not resumable: it already has observations, or its note body has content beyond an empty scaffold)"
                : " (pass --resume if this is an interrupted prior run that never added any observations and whose note body was never touched)"),
      },
      existingObservations: new Set(),
      existingOutRelations: new Set(),
    };
  }
  if (!applied) {
    return {
      outcome: {
        ...baseOutcome(e),
        action: "create",
        observationsToAdd: e.observations.length,
        observationsAlready: 0,
      },
      existingObservations: new Set(),
      existingOutRelations: new Set(),
    };
  }
  const createRes = await dispatch("create_entity", {
    vault,
    type: e.entityType,
    name: e.name,
    materialize: true,
    ...(e.observations.length > 0 ? { observations: e.observations } : {}),
  });
  if (!createRes.ok && isAlreadyExists(createRes)) {
    // Lost a create-vs-create race — re-resolve as "exists" instead of failing the whole entity.
    const retry = await readExistingEntity(dispatch, vault, e.entityType, e.name);
    if (retry.found) {
      return {
        outcome: { ...baseOutcome(e), action: "exists" },
        entityId: retry.entity.entityId,
        existingObservations: retry.entity.observations,
        existingOutRelations: retry.entity.outRelations,
      };
    }
  }
  if (!createRes.ok) {
    return {
      outcome: { ...baseOutcome(e), action: "error", reason: errMessage(createRes) },
      existingObservations: new Set(),
      existingOutRelations: new Set(),
    };
  }
  const created = createRes.data as { entity_id: string; vault_path: string | null };
  if (created.vault_path) {
    const fm = await setProvenance(
      dispatch,
      vault,
      adapter,
      created.vault_path,
      e.sourcePath,
      importedAt,
    );
    // Review finding: this result was previously discarded — a failure here left a real,
    // observation-bearing entity permanently reported as "no verifiable import provenance" on
    // every future run, with no way forward short of --resume (which this entity now qualifies
    // for, since its observations are non-empty... except --resume explicitly requires ZERO
    // observations, so a failure here with real content already written is NOT resumable by
    // design — it needs an operator's attention, which is exactly what surfacing it as an error
    // gives them, instead of a silently-successful "create" outcome).
    if (!fm.ok) {
      return {
        outcome: {
          ...baseOutcome(e),
          action: "error",
          reason: `entity created, but provenance frontmatter could not be set: ${errMessage(fm)}`,
        },
        existingObservations: new Set(),
        existingOutRelations: new Set(),
      };
    }
  }
  return {
    outcome: {
      ...baseOutcome(e),
      action: "create",
      observationsToAdd: e.observations.length,
      observationsAlready: 0,
    },
    entityId: created.entity_id,
    // All of e's observations were already included in create_entity's own call above — the
    // relation phase / a future re-run's diff must see them as already present, not re-add them.
    existingObservations: new Set(e.observations),
    existingOutRelations: new Set(),
  };
}

export interface ApplyImportOptions {
  vault: string;
  adapter: ImportAdapterName;
  dispatch: Dispatch;
  applied: boolean;
  /** See resolveEntity's own comment: relaxes the provenance-collision refusal, but ONLY for an
   *  existing entity with zero observations. Never implied by `applied` alone. */
  resume?: boolean;
  /** ISO 8601 instant stamped as `imported_at`; injectable for deterministic tests. */
  now?: () => string;
}

export async function applyImport(
  parsed: { entities: ParsedEntity[]; skipped: SkippedFile[] },
  opts: ApplyImportOptions,
): Promise<ImportReport> {
  const importedAt = (opts.now ?? (() => new Date().toISOString()))();
  const entityOutcomes: EntityOutcome[] = [];
  // Every name this batch successfully resolved (created OR already-existing OR resumed),
  // independent of dry-run — a dry-run "create" has no real id yet but IS a valid relation target
  // for the PREVIEW (the entity would exist by the time --apply runs the relation pass).
  // `batchIds` holds the real id, only ever populated when one exists.
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
      !!opts.resume,
      importedAt,
    );
    if (outcome.action === "collision" || outcome.action === "error") {
      entityOutcomes.push(outcome);
      continue;
    }
    // "create" already carries every observation via create_entity's own call (resolveEntity) —
    // only "exists"/"resumed" have a real diff-and-append to do here.
    if (outcome.action !== "create") {
      const toAdd = e.observations.filter((o) => !existingObservations.has(o));
      outcome.observationsToAdd = toAdd.length;
      outcome.observationsAlready = e.observations.length - toAdd.length;
      if (opts.applied && entityId) {
        let failed: ToolResult | null = null;
        let added = 0;
        for (const o of toAdd) {
          const r = await opts.dispatch("add_observation", {
            vault: opts.vault,
            entity_id: entityId,
            observation: o,
          });
          if (!r.ok) {
            failed = r;
            break;
          }
          added++;
        }
        if (failed) {
          // Stop work on this entity — do not proceed to its relations, do not let it become a
          // valid relation TARGET this run (an observation write failed mid-batch; its state is
          // no longer what the plan assumed). Non-zero exit is the caller's (cli/commands/
          // memory-import.ts) responsibility, gated on any "error" outcome being present.
          outcome.action = "error";
          outcome.reason = `add_observation failed after ${added}/${toAdd.length}: ${errMessage(failed)}`;
          outcome.observationsToAdd = toAdd.length - added;
          outcome.observationsAlready = e.observations.length - (toAdd.length - added);
          entityOutcomes.push(outcome);
          continue;
        }
      }
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
