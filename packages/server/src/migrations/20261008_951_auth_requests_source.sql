-- 20261008_951_auth_requests_source.sql
-- oauth.db chain (NOT cache.db, NOT auth.db). `GET /oauth/authorize` is unauthenticated and parks a
-- pending request per call, so admission is limited per client, per source and overall (design v2
-- section 8). The per-source limit needs to know whose request a row is: `source_hash` is the SHA-256
-- of the TCP peer address (never the address itself), NULL when the peer is unknown or loopback (a
-- reverse proxy or tunnel on the same host, where every caller looks alike) and for rows written
-- before this column existed. The column is only read by the admission count; no row depends on it.
ALTER TABLE auth_requests ADD COLUMN source_hash TEXT;
