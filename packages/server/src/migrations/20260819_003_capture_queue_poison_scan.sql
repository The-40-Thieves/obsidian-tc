-- 20260819_003_capture_queue_poison_scan.sql
-- THE-855: capture_queue enqueues were not poison-scanned. `enqueueCapture` is the STABLE write
-- contract the ambient capture worker (THE-175) targets, and everything landing through it is
-- untrusted captured content (screen text / audio transcripts) — exactly the shape THE-238's
-- assessPoison already exists to catch, but nothing on this path called it.
--
-- Three columns, all NULLABLE: a row written before this migration has no recoverable assessment
-- (NULL means "never scanned", not "scanned clean" — 0/‘none’ would assert a result that was never
-- computed, same reasoning as 20260806_006's eligibility_reason).
--
--   poison_risk    'none' | 'suspect' | 'high' — assessPoison's verdict at enqueue time.
--   poison_signals JSON array of the signal families that fired (e.g. '["override"]'); '[]' when
--                  risk is 'none'. Mirrors write_note/append_note's poison_assessment.signals
--                  (THE-639) — same shape, same reason (auditable, compact).
--   trust          episodeTrust(source, risk) (THE-238 channel-trust table): channel base trust
--                  times the risk multiplier, which is <= 1 for every risk value — so this column
--                  can only ever be lower than (or equal to) the channel's own base trust, never
--                  higher. A clean scan (risk 'none', multiplier 1) leaves it AT the channel base;
--                  nothing here raises it past that. Computed once, at enqueue, and never
--                  recomputed on read — there is no promotion path to guard against because none
--                  is written.
ALTER TABLE capture_queue ADD COLUMN poison_risk TEXT;
ALTER TABLE capture_queue ADD COLUMN poison_signals TEXT;
ALTER TABLE capture_queue ADD COLUMN trust REAL;
