-- 20261108_956_auth_requests_used.sql
-- oauth.db chain (NOT cache.db, NOT auth.db). A pending authorization request used to be DELETEd the
-- moment it was approved or denied, and purged the moment it expired, so a second visit could not
-- tell "already used" from "expired" from "never existed". `used_at` marks a consumed request
-- instead: the row stays as a tombstone until the purge (as-grants.ts `REQUEST_TOMBSTONE_MS` past
-- its expiry), and only rows with `used_at IS NULL` are live or count against admission. NULL for
-- every row written before this column existed, which is right: none of them was consumed.
ALTER TABLE auth_requests ADD COLUMN used_at INTEGER;
