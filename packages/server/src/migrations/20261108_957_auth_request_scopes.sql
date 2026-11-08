/* tsqllint-disable set-ansi set-nocount set-quoted-identifier set-transaction-isolation-level schema-qualify */
-- SQLite, not T-SQL: these tsqllint rules require SQL Server SET options and schema names that do
-- not apply to a single-schema SQLite database.
-- oauth.db: retain scope resolution across sign-in. Defaulted permissions require full consent;
-- dropped permissions are displayed but never granted. Live pending requests from before this
-- migration have no provenance, so discard them rather than silently reusing an approval for a
-- defaulted scope. Used tombstones can never be continued and keep their "already used" answer.
DELETE FROM auth_requests WHERE used_at IS NULL;
ALTER TABLE auth_requests ADD COLUMN scope_defaulted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auth_requests ADD COLUMN dropped_scopes TEXT NOT NULL DEFAULT '[]';
