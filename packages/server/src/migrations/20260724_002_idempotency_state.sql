-- THE-562 #13 (THE-413 residual): make the idempotency claim state machine explicit. Prior code
-- inferred state from completed_at (+ an overflow sentinel), so a post-effect fault could not be
-- distinguished from a pre-effect one and the claim was deleted → a retry re-ran a committed effect.
-- states: in_flight (claimed) -> effect_committed (handler returned, effect may be durable, response
-- not recorded) -> completed (response/overflow recorded) | indeterminate (post-effect fault).
ALTER TABLE idempotency_keys ADD COLUMN state TEXT NOT NULL DEFAULT 'in_flight';

-- Back-fill: any pre-existing finished row is 'completed'. In-flight rows stay 'in_flight'
-- (they predate the marker; reclaim treats them as before — acceptable, they are near-expiry).
UPDATE idempotency_keys SET state = 'completed' WHERE completed_at IS NOT NULL;
