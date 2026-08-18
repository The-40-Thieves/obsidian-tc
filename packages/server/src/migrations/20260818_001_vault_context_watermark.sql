-- 20260818_001_vault_context_watermark.sql
-- THE-647 item 1: differential vault_context. `since` is a client-supplied LOWER-BOUND HINT, not
-- the filter of record: vault_context floors it against this table's stored per-(caller, vault)
-- watermark (`min(clientSince, storedWatermark)`) whenever a row exists, so a client whose own
-- clock has drifted ahead — or that replays a stale cached cutoff — cannot silently lose rows.
-- Absent a stored row (a caller's genuinely first diff call), client `since` is used as-is. One row
-- per caller+vault also records the SAFE echo value (`diff_since`) a well-behaved client should
-- pass as `since` on its next call.
--
-- Borrows THE-461's watermark discipline (20260723_001_activation_watermark.sql,
-- experiential/activation.ts recomputeActivation) rather than re-deriving it: the value persisted
-- here is captured BEFORE the diff read runs and is written only AFTER the response is composed
-- successfully, and never regresses (MAX with the existing row). Combined with the floor above, a
-- row written concurrently with a diff call is never dropped, from EITHER cause: anything written
-- between capture and the read still has a timestamp past the OLD watermark (so it is included
-- this call), anything written after capture but attributed a timestamp before the NEXT watermark
-- is impossible by construction (the new watermark is always <= "now" at capture time), and the
-- floor additionally catches the case where the client's OWN `since` — not the stored watermark —
-- would have been the one to skip a row.
--
-- Not `workspace_sessions` (the ticket's own original suggestion): THE-714 found that table stays
-- EMPTY in production because no client calls start_session, which would make a diff feature keyed
-- on it silently inert for every real caller.
CREATE TABLE IF NOT EXISTS vault_context_watermark (
  caller     TEXT NOT NULL,   -- CallerContext.caller, coerced to '' when null (composite PK
                               -- cannot carry NULL meaningfully); mirrors agent_episodes.caller.
  vault_id   TEXT NOT NULL,
  watermark  INTEGER NOT NULL DEFAULT 0,  -- ms epoch, same clock as chunks.updated_at
  PRIMARY KEY (caller, vault_id)
);
