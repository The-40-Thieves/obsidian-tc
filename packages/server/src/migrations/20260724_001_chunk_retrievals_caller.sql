-- THE-568 (P1.7 follow-up): per-caller ownership of retrieval feedback. chunk_retrievals carried
-- only session_id, so feedback ownership was session-granular. Add caller so record_retrieval_feedback
-- can gate on the calling principal, mirroring the agent_episodes partition.
ALTER TABLE chunk_retrievals ADD COLUMN caller TEXT;
CREATE INDEX IF NOT EXISTS idx_chunk_retrievals_caller ON chunk_retrievals(caller) WHERE caller IS NOT NULL;
