-- 20260818_001_vault_context_watermark.sql
-- THE-647 item 1: differential vault_context. `since` filters notes/syntheses/contradictions/
-- episodes to rows newer than a per-(caller, vault) cutoff. One row per caller+vault records the
-- SAFE echo value (`diff_since`) a well-behaved client should pass as `since` on its next call.
--
-- Borrows THE-461's watermark discipline (20260723_001_activation_watermark.sql,
-- experiential/activation.ts recomputeActivation) rather than re-deriving it: the value persisted
-- here is captured BEFORE the diff read runs and is written only AFTER the response is composed
-- successfully, and never regresses (MAX with the existing row). A client that always echoes the
-- previous response's `diff_since` back as its next `since` therefore never has a row dropped —
-- anything written between capture and the read still has a timestamp past the OLD watermark (so
-- it is included this call), and anything written after capture but attributed a timestamp before
-- the NEXT watermark is impossible by construction (the new watermark is always <= "now" at
-- capture time, and nothing written after capture can carry an earlier timestamp).
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
