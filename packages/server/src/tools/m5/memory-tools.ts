// Domain 22 — Memory entities + [[link]] graph (G2.1), WRITE half: create_entity,
// add_observation, link_entities. get_entity/query_entity_graph (the read half) live in
// memory-read-tools.ts — split purely to stay under biome's 700-line ceiling; both share
// memory-projection.ts's materialization helpers so neither imports the other. SQLite is the
// SOURCE OF TRUTH; each materialized entity also gets a regenerable .md projection so its
// [[links]] resolve in Obsidian's graph. Mutations take write:memory (write family — readOnly
// kill-switch applies, no execute HITL floor; spec hitl:never). Materialization funnels through
// resolveVaultPath + enforcePathAcl; the write ACL is pre-checked before the SQLite insert so an
// ACL denial leaves no orphan row. THE-567: the memory-note path is server-computed (folder +
// type + name), not input-derivable, so it cannot be declared via a central pathAcl extractor —
// ctx.grantedScopes is threaded into every handler-side enforcePathAcl call instead, so the
// P1.4 rule-scope gate still applies here.
import { err, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { inWriteTransaction } from "../../db/txn";
import {
  enforceMemoryDefense,
  enforceMemoryDefenseOnTransformed,
} from "../../experiential/memory-defense";
import { redactSecrets } from "../../experiential/redact";
import type { ToolDefinition } from "../../mcp/registry";
import {
  appendObservation,
  closeOpenInterval,
  deleteEntity,
  deleteRelation,
  type EntityRow,
  findEntity,
  getEntityById,
  insertEntity,
  insertObservationInterval,
  insertRelation,
  isUniqueViolation,
  normalizeObservationKey,
  normalizeObservationText,
  type ObservationView,
  observationViews,
  obsHash,
  parseObservations,
  setEntityVaultPath,
} from "../../memory/entities";
import { entityNotePath, sanitizeSegment } from "../../memory/materialize";
import { enforcePathAcl } from "../../vault/acl-path";
import { defineTool } from "../m1/define";
import {
  assertMemoryPathReadable,
  getReadableEntity,
  materializeProjection,
  rematerialize,
} from "./memory-projection";
import type { M5Deps } from "./shared";
import { memoryDefenseFor, memoryFolderFor, parseIso } from "./shared";

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
  redactions: z.number().int().nonnegative().optional(),
});

const AddObservationOutput = z.object({
  entity_id: z.string(),
  observation_count: z.number(),
  updated_at: z.number(),
  vault_path: z.string().nullable(),
  redactions: z.number().int().nonnegative().optional(),
});

const LinkEntitiesOutput = z.object({
  source_id: z.string(),
  target_id: z.string(),
  relation_type: z.string(),
  created_at: z.number(),
  existed_already: z.boolean(),
  source_vault_path: z.string().nullable(),
  redactions: z.number().int().nonnegative().optional(),
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
        const mdConfig = memoryDefenseFor(deps, v.id);
        // Security review round: `observations` is passed through as a REAL array (not flattened
        // to `observations.0`/`observations.1` fields) so it goes through the same array-join
        // scan `walk()` applies to any array — a secret split across two observation elements,
        // each half innocuous alone, is caught at the reassembled ("\n"-joined) boundary.
        const mdFields: Record<string, unknown> = { type: input.type, name: input.name };
        if (input.observations !== undefined) mdFields.observations = input.observations;
        const scan = enforceMemoryDefense(mdConfig, mdFields, { metrics: deps.metrics });
        const rawType = scan.fields.type as string;
        const rawName = scan.fields.name as string;
        const observations = scan.fields.observations as string[] | undefined;

        // `type`/`name` also become the materialized note's PATH segments (entityNotePath ->
        // sanitizeSegment) AFTER the scan above, which can turn a non-matching raw string into a
        // secret-shaped one (`sk:...` -> `sk-...`) — re-scan the sanitized form too.
        const typeScan = enforceMemoryDefenseOnTransformed(
          mdConfig,
          "type",
          rawType,
          sanitizeSegment(rawType),
          { metrics: deps.metrics },
        );
        const nameScan = enforceMemoryDefenseOnTransformed(
          mdConfig,
          "name",
          rawName,
          sanitizeSegment(rawName),
          { metrics: deps.metrics },
        );
        const type = typeScan.value;
        const name = nameScan.value;
        const pathSegmentRedactions = typeScan.redactions + nameScan.redactions;

        const now = (ctx.now ?? Date.now)();
        const folder = memoryFolderFor(deps, v.id);
        const notePath = entityNotePath(folder, type, name);
        // READ (and, materializing, WRITE) the claimed path BEFORE the collision lookup, so "already
        // exists" is only said to a caller who could read that entity; no orphan row on a denial.
        assertMemoryPathReadable(ctx, notePath);
        if (input.materialize)
          enforcePathAcl(ctx.acl, "write", notePath, v.root, ctx.grantedScopes);
        if (findEntity(ctx.db, v.id, type, name))
          throw err.invalidInput("entity already exists", { type, name });
        let e: EntityRow;
        try {
          e = insertEntity(ctx.db, {
            vaultId: v.id,
            entityType: type,
            name,
            observations,
            materialize: input.materialize,
            now,
          });
        } catch (caught) {
          // The UNIQUE natural-key index closes the findEntity read-then-insert race (F4).
          if (isUniqueViolation(caught))
            throw err.invalidInput("entity already exists", { type, name });
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
          ...(scan.redactions + pathSegmentRedactions > 0
            ? { redactions: scan.redactions + pathSegmentRedactions }
            : {}),
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
        const mdConfig = memoryDefenseFor(deps, v.id);
        // `key` is scanned AFTER normalizeObservationKey lowercases it (below) — the raw
        // (possibly mixed-case) key let `SK-...` dodge `\bsk-` while still landing on disk
        // lowercased. The new `observation` text is scanned further down, JOINED with the
        // entity's existing observations (security review round: a secret split across an
        // earlier append and this new one must be caught at the reassembled boundary, not just
        // scanned in isolation) — see the `!retireOnly` branch inside the write transaction.
        let observationInput: string | undefined;
        let observationRedactions = 0;

        let key: string | null = null;
        let keyRedactions = 0;
        if (input.key !== undefined) {
          const normalized = normalizeObservationKey(input.key);
          if (normalized === null)
            // Throws on the RAW input.key, before the scan below runs — always redact the echo,
            // independent of memoryDefense.mode, so an invalid key never leaks verbatim.
            throw err.invalidInput("key must match ^[a-z0-9][a-z0-9_.-]*$ once lowercased", {
              key: redactSecrets(input.key).text,
            });
          const keyScan = enforceMemoryDefense(
            mdConfig,
            { key: normalized },
            { metrics: deps.metrics },
          );
          key = keyScan.fields.key as string;
          keyRedactions = keyScan.redactions;
        }
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
          const existing = getReadableEntity(deps, ctx, v.id, input.entity_id);
          if (!existing) throw err.invalidInput("entity not found", { entity_id: input.entity_id });
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

          // Security review round: scan the JOINED text (existing observations + this new one),
          // not just the new one in isolation — a secret split across an earlier append and this
          // call would otherwise reassemble unmatched on disk. Reuses the same array-join path
          // `walk()` already applies to any real array field; only the LAST (new) element is used
          // below, so an existing observation's own already-persisted text is never rewritten.
          if (!retireOnly) {
            const existingObs = parseObservations(existing.observations);
            const joinScan = enforceMemoryDefense(
              mdConfig,
              { observations: [...existingObs, input.observation as string] },
              { metrics: deps.metrics },
            );
            const scannedObs = joinScan.fields.observations as string[];
            observationInput = scannedObs[scannedObs.length - 1] as string;
            observationRedactions = joinScan.redactions;
          }

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
            const text = observationInput as string;
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
            const r = appendObservation(ctx.db, existing.id, observationInput as string, now);
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
            ...(observationRedactions + keyRedactions > 0
              ? { redactions: observationRedactions + keyRedactions }
              : {}),
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
        const src = getReadableEntity(deps, ctx, v.id, input.source_id);
        const tgt = getReadableEntity(deps, ctx, v.id, input.target_id);
        if (!src) throw err.invalidInput("source entity not found", { entity_id: input.source_id });
        if (!tgt) throw err.invalidInput("target entity not found", { entity_id: input.target_id });
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
        const mdConfig = memoryDefenseFor(deps, v.id);
        const scan = enforceMemoryDefense(
          mdConfig,
          { relation_type: input.relation_type },
          { metrics: deps.metrics },
        );
        const relationType = scan.fields.relation_type as string;
        const now = (ctx.now ?? Date.now)();
        const { existedAlready } = insertRelation(ctx.db, src.id, tgt.id, relationType, now);
        let sourceVaultPath: string | null;
        try {
          sourceVaultPath = rematerialize(deps, ctx, v, src, now);
        } catch (caught) {
          // Same orphan-avoidance as create_entity above: a materialization refusal must not
          // leave a relation row this call did not exist to have. Only roll back a relation THIS
          // call actually created — never delete an edge that already existed before it.
          if (!existedAlready) deleteRelation(ctx.db, src.id, tgt.id, relationType);
          throw caught;
        }
        return {
          source_id: src.id,
          target_id: tgt.id,
          relation_type: relationType,
          created_at: now,
          existed_already: existedAlready,
          source_vault_path: sourceVaultPath,
          ...(scan.redactions > 0 ? { redactions: scan.redactions } : {}),
        };
      },
    }),
  ];
}
