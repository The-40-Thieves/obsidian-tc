-- oauth.db: retain scope resolution across sign-in. Defaulted permissions require full consent;
-- dropped permissions are displayed but never granted. Pending requests from before this migration
-- have no provenance, so discard them rather than silently reusing an approval for a defaulted scope.
DELETE FROM auth_requests;
ALTER TABLE auth_requests ADD COLUMN scope_defaulted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auth_requests ADD COLUMN dropped_scopes TEXT NOT NULL DEFAULT '[]';
