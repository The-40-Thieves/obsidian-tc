// Domain 22 — Memory entities + [[link]] graph (G2.1). Five tools over the SQLite
// memory_entities + memory_relations tables: create_entity, get_entity,
// add_observation, link_entities, query_entity_graph. SQLite is the SOURCE OF TRUTH;
// each materialized entity also gets a regenerable .md projection so its [[links]]
// resolve in Obsidian's graph. Reads take read:memory, mutations take write:memory
// (write family — readOnly kill-switch applies, no execute HITL floor; spec hitl:never).
// Materialization funnels through resolveVaultPath + enforcePathAcl; the write ACL is
// pre-checked before the SQLite insert so an ACL denial leaves no orphan row. THE-567: the
// memory-note path is server-computed (folder + type + name), not input-derivable, so it cannot
// be declared via a central pathAcl extractor — ctx.grantedScopes is threaded into every
// handler-side enforcePathAcl call instead, so the P1.4 rule-scope gate still applies here.
import { err, Pagination, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { inWriteTransaction } from "../../db/txn";
import type { ToolDefinition } from "../../mcp/registry";
import {
  appendObservation,
  bfsGraph,
  closeOpenInterval,
  deleteEntity,
  deleteRelation,
  type EntityRow,
  findEntitiesByName,
  findEntity,
  getEntityById,
  insertEntity,
  insertObservationInterval,
  insertRelation,
  isUniqueViolation,
  normalizeObservationKey,
  normalizeObservationText,
  type ObservationView,
  observationsAsOf,
  observationViews,
  obsHash,
  relationsForEntity,
  setEntityVaultPath,
} from "../../memory/entities";
import { entityNotePath } from "../../memory/materialize";
import { enforcePathAcl } from "../../vault/acl-path";
import { defineTool } from "../m1/define";
import { materializeProjection, rematerialize } from "./memory-projection";
import type { M5Deps } from "./shared";
import { memoryFolderFor, parseIso } from "./shared";

/** THE-833: an entity is visible unless it's retired and the caller didn't opt in. Shared by
 *  get_entity (single lookup + the by-name ambiguity candidates) and query_entity_graph (the BFS
 *  result set) so "filtered by default" means the same thing in both places. */
function isVisible(e: Pick<EntityRow, "status">, includeRetired: boolean): boolean {
  return includeRetired || e.status !== "retired";
}

// THE-1130: one observation, as returned to a caller — the wire shape every tool that exposes
// observations (get_entity, query_entity_graph) emits, so "what a fact looks like on the wire"
// has exactly one definition. zod's safeParse silently strips an undeclared field and reports
// success (see reference_obsidian_tc_zod_safeparse_strips_but_ajv_rejects_extra_keys) — every
// field ObservationView carries is declared here, none silently dropped at the MCP boundary.
const ObservationSchema = z.object({
  text: z.string(),
  key: z.string().nullable(),
  valid_from: z.number(),
  valid_to: z.number().nullable(),
  superseded_by: z.string().nullable(),
});

function toObservationOutput(o: ObservationView): z.infer<typeof ObservationSchema> {
  return {
    text: o.text,
    key: o.key,
    valid_from: o.validFrom,
    valid_to: o.validTo,
    superseded_by: o.supersededBy,
  };
}

// `^[a-z0-9][a-z0-9_.-]*$`, max 64 chars — see memory/entities.ts's OBSERVATION_KEY_RE. The zod
// regex is kept in lockstep with (not derived from) that one: both must agree on what a legal key
// looks like, but the zod schema also needs the length bound and the lowercase-before-validate
// step, which normalizeObservationKey (not a zod primitive) is what actually enforces — this
// schema's `.regex` is a fast, honest input-shape check; normalizeObservationKey in the handler is
// the single source of truth the value is actually validated and normalized against.
const ObservationKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/i, "key must match ^[a-z0-9][a-z0-9_.-]*$ (case-insensitive)");

// THE-1130 adversarial-review fix: the ONE schema boundary create_entity's `observations` array
// and add_observation's `observation` field both validate a single observation's text against —
// see memory/entities.ts's normalizeObservationText for the full rationale. REJECTS (never
// silently splits or drops) a blank-after-trim value or one containing an embedded `\r`/`\n`: a
// caller with more than one fact makes more than one call. `.transform` (not `.refine`) so the
// TRIMMED value is what the handler actually receives — it never re-trims.
const NormalizedObservationText = z
  .string()
  .min(1)
  .transform((raw, ctx) => {
    const text = normalizeObservationText(raw);
    if (text === null) {
      ctx.addIssue({
        code: "custom",
        message:
          "observation must be non-blank after trimming and must not contain \\r or \\n — call add_observation once per fact",
      });
      return z.NEVER;
    }
    return text;
  });

// THE-417: written from each handler's return statement. `observations` is (THE-1130)
// observationViews'/observationsAsOf's zip of EntityRow.observations with its interval rows, and
// `relations` is
// relationsForEntity's join projection, not the raw memory_relations columns.
const CreateEntityOutput = z.object({
  entity_id: z.string(),
  type: z.string(),
  name: z.string(),
  status: z.enum(["active", "retired"]),
  materialized: z.boolean(),
  vault_path: z.string().nullable(),
  created_at: z.number(),
});

const EntityRelation = z.object({
  target_id: z.string(),
  target_name: z.string(),
  target_type: z.string(),
  relation_type: z.string(),
  direction: z.enum(["out", "in"]),
});

const GetEntityOutput = z.object({
  entity_id: z.string(),
  type: z.string(),
  name: z.string(),
  status: z.enum(["active", "retired"]),
  // THE-1130: observations valid `as_of` the input (default: now) — see add_observation's own
  // schema for what valid_from/valid_to/superseded_by mean on each one.
  observations: z.array(ObservationSchema),
  relations: z.array(EntityRelation),
  vault_path: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  as_of: z.number(),
});

const AddObservationOutput = z.object({
  entity_id: z.string(),
  observation_count: z.number(),
  updated_at: z.number(),
  vault_path: z.string().nullable(),
});

const LinkEntitiesOutput = z.object({
  source_id: z.string(),
  target_id: z.string(),
  relation_type: z.string(),
  created_at: z.number(),
  existed_already: z.boolean(),
  source_vault_path: z.string().nullable(),
});

const GraphNodeItem = z.object({
  entity_id: z.string(),
  type: z.string(),
  name: z.string(),
  status: z.enum(["active", "retired"]),
  distance: z.number(),
  // bfsGraph's GraphNode.path: the hop-by-hop trail from the seed, not a vault path.
  path: z.array(z.object({ via_entity_id: z.string(), via_relation: z.string() })),
  // THE-1130: each node's own observations, valid `as_of` the query's as_of (default: now) — same
  // shape and same filter get_entity applies, so "what did we believe as_of D" answers the same
  // way whether reached by a direct get_entity or by a graph traversal that passes through it.
  observations: z.array(ObservationSchema),
});

const QueryEntityGraphOutput = z.object({
  vault: z.string(),
  as_of: z.number(),
  seed_entity_id: z.string(),
  items: z.array(GraphNodeItem),
  next_cursor: z.string().nullable(),
  total_returned: z.number(),
});

export function buildMemoryTools(deps: M5Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "create_entity",
      domain: "knowledge",
      vaultArg: "vault",
      description:
        "Create a typed memory entity (optionally materialized as a vault .md note). SQLite is the source of truth. Each string in `observations` must be a single non-blank fact with no embedded newline — a caller with more than one fact passes more than one array element. Domain: knowledge.",
      inputSchema: z
        .object({
          vault: VaultId,
          type: z.string().min(1),
          name: z.string().min(1),
          observations: z.array(NormalizedObservationText).optional(),
          materialize: z.boolean().default(true),
        })
        .strict(),
      outputSchema: CreateEntityOutput,
      requiredScopes: ["write:memory"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        if (findEntity(ctx.db, v.id, input.type, input.name))
          throw err.invalidInput("entity already exists", { type: input.type, name: input.name });
        const now = (ctx.now ?? Date.now)();
        const folder = memoryFolderFor(deps, v.id);
        // Pre-check the materialization ACL so a denial leaves no orphan SQLite row.
        if (input.materialize)
          enforcePathAcl(
            ctx.acl,
            "write",
            entityNotePath(folder, input.type, input.name),
            v.root,
            ctx.grantedScopes,
          );
        let e: EntityRow;
        try {
          e = insertEntity(ctx.db, {
            vaultId: v.id,
            entityType: input.type,
            name: input.name,
            observations: input.observations,
            materialize: input.materialize,
            now,
          });
        } catch (caught) {
          // The UNIQUE natural-key index closes the findEntity read-then-insert race (F4).
          if (isUniqueViolation(caught))
            throw err.invalidInput("entity already exists", { type: input.type, name: input.name });
          throw caught;
        }
        let vaultPath: string | null;
        try {
          vaultPath = input.materialize ? rematerialize(deps, ctx, v, e, now) : null;
        } catch (caught) {
          // Roll back the just-inserted row: a materialization refusal (a note already sitting at
          // this path that this brand-new entity does not own — materialize.ts's ownership check)
          // must never leave an orphan memory_entities row with no note, or worse a stranger's
          // note silently claimed. Mirrors delete_entity's own row removal (memory-lifecycle-tools.ts).
          deleteEntity(ctx.db, e.id);
          throw caught;
        }
        return {
          entity_id: e.id,
          type: e.entity_type,
          name: e.name,
          status: e.status,
          materialized: input.materialize,
          vault_path: vaultPath,
          created_at: e.created_at,
        };
      },
    }),

    defineTool({
      name: "get_entity",
      domain: "knowledge",
      description:
        "Read a memory entity by id, by type+name, or by unique name, with its observations and relations. Retired entities are hidden unless include_retired is set. Observations returned are filtered by as_of — a fact is included when valid_from <= as_of and (valid_to is unset or as_of < valid_to). Default as_of is now, so an as_of in the PAST excludes any observation added after that instant, even one that is still open today.",
      inputSchema: z
        .object({
          vault: VaultId,
          entity_id: z.string().optional(),
          type: z.string().optional(),
          name: z.string().optional(),
          include_retired: z.boolean().default(false),
          as_of: z.number().int().nonnegative().optional(),
        })
        .strict(),
      outputSchema: GetEntityOutput,
      requiredScopes: ["read:memory"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        let e: EntityRow | undefined;
        if (input.entity_id) {
          const found = getEntityById(ctx.db, input.entity_id);
          e = found && found.vault_id === v.id ? found : undefined;
        } else if (input.type && input.name) {
          e = findEntity(ctx.db, v.id, input.type, input.name);
        } else if (input.name) {
          // THE-833: a retired entity sharing a name with an active one should not count toward
          // ambiguity when the caller hasn't opted in to see retired entities at all — filter the
          // candidate set FIRST, the same order get_entity applies the filter to a resolved `e`.
          const hits = findEntitiesByName(ctx.db, v.id, input.name).filter((h) =>
            isVisible(h, input.include_retired),
          );
          if (hits.length > 1)
            throw err.invalidInput("entity name is ambiguous; provide type", {
              name: input.name,
              candidates: hits.map((h) => ({ entity_id: h.id, type: h.entity_type })),
            });
          e = hits[0];
        } else {
          throw err.invalidInput("provide entity_id, or type+name, or name");
        }
        if (!e || !isVisible(e, input.include_retired))
          throw err.invalidInput("entity not found", { vault: v.id });
        const relations = relationsForEntity(ctx.db, e.id).map((r) => ({
          target_id: r.other_id,
          target_name: r.other_name,
          target_type: r.other_type,
          relation_type: r.relation_type,
          direction: r.direction,
        }));
        const asOf = input.as_of ?? (ctx.now ?? Date.now)();
        return {
          entity_id: e.id,
          type: e.entity_type,
          name: e.name,
          status: e.status,
          observations: observationsAsOf(ctx.db, e, asOf).map(toObservationOutput),
          relations,
          vault_path: e.vault_path,
          created_at: e.created_at,
          updated_at: e.updated_at,
          as_of: asOf,
        };
      },
    }),

    defineTool({
      name: "add_observation",
      domain: "knowledge",
      vaultArg: "vault",
      acceptsIdempotencyKey: true,
      description:
        "Append a fact to a memory entity (re-materializing its note when materialized). `observation` must be a single non-blank fact with no embedded newline — a caller with more than one fact calls this more than once. An optional `key` opts the observation INTO supersession tracking — when the same entity already has an OPEN observation with that key, it is closed (not deleted: its text stays under the note's Superseded section, its interval's valid_to is set and superseded_by records what replaced it) and the new text opens a fresh interval. An observation added with no key never supersedes anything and is never superseded automatically; it just appends. Matching is always by this explicit key, never inferred from text similarity. `valid_from`/`valid_to` (ISO 8601) let a caller backdate a fact or bound it explicitly. To retire a keyed fact WITHOUT replacing it, omit `observation` and pass `key` + `valid_to` — closes the open interval for that key with no new text appended. Domain: knowledge.",
      inputSchema: z
        .object({
          vault: VaultId,
          entity_id: z.string().min(1),
          observation: NormalizedObservationText.optional(),
          key: ObservationKeySchema.optional(),
          valid_from: z.string().datetime({ offset: true }).optional(),
          valid_to: z.string().datetime({ offset: true }).optional(),
          idempotency_key: z.string().min(1).max(128).optional(),
        })
        .strict()
        .superRefine((data, ctx2) => {
          if (data.observation === undefined) {
            if (data.key === undefined || data.valid_to === undefined)
              ctx2.addIssue({
                code: "custom",
                message: "observation is required unless key and valid_to are both provided",
              });
            if (data.valid_from !== undefined)
              ctx2.addIssue({
                code: "custom",
                message:
                  "valid_from has no effect without observation (nothing new is being opened)",
                path: ["valid_from"],
              });
          }
        }),
      outputSchema: AddObservationOutput,
      requiredScopes: ["write:memory"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const now = (ctx.now ?? Date.now)();
        const key = input.key !== undefined ? normalizeObservationKey(input.key) : null;
        if (input.key !== undefined && key === null)
          throw err.invalidInput("key must match ^[a-z0-9][a-z0-9_.-]*$ once lowercased", {
            key: input.key,
          });
        const validFrom =
          input.valid_from !== undefined
            ? (parseIso(input.valid_from, "valid_from") as number)
            : now;
        const validTo =
          input.valid_to !== undefined ? (parseIso(input.valid_to, "valid_to") as number) : null;
        const retireOnly = input.observation === undefined;
        // Only checked against `validFrom` (now, or the caller's own backdate) when a NEW interval
        // is actually being opened — a retire-only call's `validTo` is checked below, inside the
        // transaction, against the interval it's ACTUALLY closing (found by key), not against
        // `now`: a caller retiring a fact effective yesterday is backdating the retirement, not
        // making a mistake.
        if (!retireOnly && validTo !== null && validTo <= validFrom)
          throw err.invalidInput("valid_to must be after valid_from", {
            valid_from: validFrom,
            valid_to: validTo,
          });

        // THE-573 (residual #2): `existing` used to be read, the next-observations list derived,
        // and the note rendered to disk ALL BEFORE this transaction opened — only the SQLite
        // append and the idempotency marker were inside it. That split let the file and the DB
        // disagree in two real ways:
        //  1. A contended `BEGIN IMMEDIATE` can fail with plain SQLITE_BUSY after exhausting
        //     busy_timeout (txn.ts:119-127), and that failure is NOT retryable by raising the
        //     timeout. By the time it fired, the note below had already been rendered to disk, so
        //     the file gained an observation that never reached SQLite.
        //  2. A second connection can commit between our read and our write. appendObservation
        //     re-reads the row itself (entities.ts:135) inside ITS OWN transaction, so SQLite ends
        //     up correct — but the note we already rendered from the stale snapshot is missing the
        //     interleaved observation. (The ticket's "two concurrent calls" framing is wrong: this
        //     handler has zero `await`s, so two in-process dispatches cannot interleave here at
        //     all — the trigger is a SECOND connection, or process, sharing the same vault.)
        //
        // Fix: take the write lock BEFORE the read, and do the read, the ACL check, the render, and
        // the append all inside it. A failed BEGIN IMMEDIATE now never runs the render at all (closes
        // #1), and a second connection's BEGIN IMMEDIATE blocks until we commit, then re-reads OUR
        // committed state (closes #2) — cross-connection writers serialize on the write lock instead
        // of racing past each other.
        //
        // The cost, paid on every call to a materialized entity: a filesystem write now happens
        // INSIDE the held write lock, lengthening the `memory_observation` lock hold. That is
        // exactly the series THE-585's onLockWait histogram measures, so the cost is observable
        // rather than theoretical — keep the fs write below as tight as possible.
        //
        // Rendering AFTER the commit instead (so the lock never covers the fs write) was rejected:
        // it would turn a currently-retryable pre-effect failure into a caller-visible
        // `indeterminate_outcome`. A background reconciler was rejected too: more code for a
        // guarantee this lock already gives for free. `ctx.markEffectCommitted?.()` stays INSIDE
        // the transaction (registry.ts:1209-1225 depends on this), called only once the checks that
        // can still fail cleanly (not-found, ACL) are behind us.
        return inWriteTransaction(ctx.db, "memory_observation", () => {
          const existing = getEntityById(ctx.db, input.entity_id);
          if (!existing || existing.vault_id !== v.id)
            throw err.invalidInput("entity not found", { entity_id: input.entity_id });
          // THE-567 fix: pre-check the materialization ACL BEFORE the SQLite append (mirrors
          // create_entity) so a caller lacking the note folder's rule-scope cannot get the
          // observation durably committed to the graph while only the note write is blocked.
          // rematerialize() only touches a note when materialize===1, so gate on that condition.
          if (existing.materialize === 1)
            enforcePathAcl(
              ctx.acl,
              "write",
              entityNotePath(memoryFolderFor(deps, v.id), existing.entity_type, existing.name),
              v.root,
              ctx.grantedScopes,
            );

          // THE-1130: the current full observation set, in blob order — nextViews below is built
          // from THIS in-memory snapshot (never re-read from SQLite) so the render, a few lines
          // down, reflects the state about to be committed, matching THE-573's own discipline.
          const views = observationViews(ctx.db, existing);
          const openIdx =
            key !== null ? views.findIndex((o) => o.key === key && o.validTo === null) : -1;

          if (retireOnly && openIdx < 0)
            throw err.invalidInput("no open observation for that key", {
              entity_id: existing.id,
              key,
            });
          if (retireOnly && (validTo as number) <= (views[openIdx] as ObservationView).validFrom)
            throw err.invalidInput("valid_to must be after the observation's own valid_from", {
              valid_from: (views[openIdx] as ObservationView).validFrom,
              valid_to: validTo,
            });

          ctx.markEffectCommitted?.();

          let nextViews: ObservationView[];
          let newHash: string | null = null;
          if (retireOnly) {
            nextViews = views.map((o, i) =>
              i === openIdx ? { ...o, validTo: validTo as number } : o,
            );
          } else {
            // Already trimmed and \r/\n-free — NormalizedObservationText validated this at the
            // schema boundary (THE-1130 adversarial-review fix). Passed through unchanged, not
            // re-trimmed: the reserialize below (appendObservation) is then a no-op for every
            // EXISTING line, only the new one is added.
            const text = input.observation as string;
            newHash = obsHash(text);
            const closed =
              openIdx >= 0
                ? views.map((o, i) => (i === openIdx ? { ...o, validTo: validFrom } : o))
                : views;
            nextViews = [...closed, { text, key, validFrom, validTo, supersededBy: null }];
          }

          const vaultPath =
            existing.materialize === 1
              ? materializeProjection(deps, ctx, v, existing, nextViews)
              : existing.vault_path;

          // DB writes mirror the in-memory state just rendered above, in the same order.
          if (retireOnly) {
            closeOpenInterval(ctx.db, existing.id, key as string, validTo as number, null);
          } else {
            if (openIdx >= 0)
              closeOpenInterval(ctx.db, existing.id, key as string, validFrom, newHash);
            const r = appendObservation(ctx.db, existing.id, input.observation as string, now);
            if (!r) throw err.invalidInput("entity not found", { entity_id: input.entity_id });
            insertObservationInterval(ctx.db, {
              entityId: existing.id,
              obsHash: newHash as string,
              key,
              validFrom,
              validTo,
              now,
            });
          }
          // Always bumped, even for a retire-only call on an unmaterialized entity — appendObservation's
          // own UPDATE already covers the append path (setEntityVaultPath's second write there is
          // redundant but harmless); this is the only writer of updated_at on the retire-only path.
          setEntityVaultPath(ctx.db, existing.id, vaultPath, now);

          // THE-1130 adversarial-review fix: ASSERT the text/interval-row lockstep invariant
          // rather than silently trusting it — throws (rolling back this whole transaction, since
          // we're still inside inWriteTransaction) on a drift instead of committing one.
          observationViews(ctx.db, getEntityById(ctx.db, existing.id) as EntityRow);

          return {
            entity_id: existing.id,
            observation_count: nextViews.length,
            updated_at: now,
            vault_path: vaultPath,
          };
        });
      },
    }),

    defineTool({
      name: "link_entities",
      domain: "knowledge",
      vaultArg: "vault",
      description:
        "Create a typed relation between two memory entities (idempotent; re-materializes the source's [[links]]). Domain: knowledge.",
      inputSchema: z
        .object({
          vault: VaultId,
          source_id: z.string().min(1),
          target_id: z.string().min(1),
          relation_type: z.string().min(1),
        })
        .strict(),
      outputSchema: LinkEntitiesOutput,
      requiredScopes: ["write:memory"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const src = getEntityById(ctx.db, input.source_id);
        const tgt = getEntityById(ctx.db, input.target_id);
        if (!src || src.vault_id !== v.id)
          throw err.invalidInput("source entity not found", { entity_id: input.source_id });
        if (!tgt || tgt.vault_id !== v.id)
          throw err.invalidInput("target entity not found", { entity_id: input.target_id });
        // THE-567 fix: pre-check the SOURCE's materialization ACL BEFORE the SQLite relation
        // insert (mirrors create_entity) so a caller lacking the note folder's rule-scope cannot
        // get the edge durably committed while only the note write is blocked. link_entities only
        // re-materializes the source's note (the target's [[links]] projection is unaffected), so
        // only the source path needs gating here.
        if (src.materialize === 1)
          enforcePathAcl(
            ctx.acl,
            "write",
            entityNotePath(memoryFolderFor(deps, v.id), src.entity_type, src.name),
            v.root,
            ctx.grantedScopes,
          );
        const now = (ctx.now ?? Date.now)();
        const { existedAlready } = insertRelation(ctx.db, src.id, tgt.id, input.relation_type, now);
        let sourceVaultPath: string | null;
        try {
          sourceVaultPath = rematerialize(deps, ctx, v, src, now);
        } catch (caught) {
          // Same orphan-avoidance as create_entity above: a materialization refusal must not
          // leave a relation row this call did not exist to have. Only roll back a relation THIS
          // call actually created — never delete an edge that already existed before it.
          if (!existedAlready) deleteRelation(ctx.db, src.id, tgt.id, input.relation_type);
          throw caught;
        }
        return {
          source_id: src.id,
          target_id: tgt.id,
          relation_type: input.relation_type,
          created_at: now,
          existed_already: existedAlready,
          source_vault_path: sourceVaultPath,
        };
      },
    }),

    defineTool({
      name: "query_entity_graph",
      domain: "knowledge",
      description:
        "Traverse the memory graph from a seed entity (BFS, depth-limited, type/direction filtered). Retired entities are excluded from the seed and the result set unless include_retired is set — traversal still walks THROUGH a retired node to reach its neighbors, only the returned/visible set is filtered. Each returned node's observations are filtered by as_of (default now — see get_entity's own description for the exact rule), so a graph walk answers 'what did we believe as_of D' the same way a direct get_entity does. Domain: knowledge.",
      inputSchema: z
        .object({
          vault: VaultId,
          seed_entity_id: z.string().min(1),
          depth: z.number().int().positive().max(5).optional(),
          relation_types: z.array(z.string()).optional(),
          entity_types: z.array(z.string()).optional(),
          direction: z.enum(["out", "in", "both"]).default("both"),
          include_retired: z.boolean().default(false),
          as_of: z.number().int().nonnegative().optional(),
        })
        .merge(Pagination)
        .strict(),
      outputSchema: QueryEntityGraphOutput,
      requiredScopes: ["read:memory"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const seed = getEntityById(ctx.db, input.seed_entity_id);
        if (!seed || seed.vault_id !== v.id || !isVisible(seed, input.include_retired))
          throw err.invalidInput("seed entity not found", { seed_entity_id: input.seed_entity_id });
        const allNodes = bfsGraph(ctx.db, seed.id, {
          depth: input.depth,
          direction: input.direction,
          relationTypes: input.relation_types,
          entityTypes: input.entity_types,
        });
        // THE-833: filter AFTER the walk, not during it (unlike bfsGraph's own entity_types/
        // relation_types filters, which prune mid-traversal and so can make a downstream node
        // unreachable through a filtered-out one). A retired node can still be a legitimate bridge
        // — e.g. a deprecated tool [[link]]ing to its replacement — and excluding it mid-BFS would
        // silently sever that path. Only which nodes are RETURNED is affected here.
        const nodes = allNodes.filter((n) => isVisible(n.entity, input.include_retired));
        const limit = input.limit ?? 100;
        const start = input.cursor ? Number.parseInt(input.cursor, 10) || 0 : 0;
        const page = nodes.slice(start, start + limit);
        const next = start + limit < nodes.length ? String(start + limit) : null;
        const asOf = input.as_of ?? (ctx.now ?? Date.now)();
        return {
          vault: v.id,
          as_of: asOf,
          seed_entity_id: seed.id,
          items: page.map((n) => ({
            entity_id: n.entity.id,
            type: n.entity.entity_type,
            name: n.entity.name,
            status: n.entity.status,
            distance: n.distance,
            path: n.path,
            observations: observationsAsOf(ctx.db, n.entity, asOf).map(toObservationOutput),
          })),
          next_cursor: next,
          total_returned: page.length,
        };
      },
    }),
  ];
}
