-- Hashed credential lookup and uniqueness indexes (MUS-70).
--
-- Secrets are SHA-256 hashes in these tables; plaintext credentials never
-- reach SQL or an index.  The device-grant hashes and OAuth code/refresh
-- hashes already have UNIQUE indexes (or PRIMARY KEY constraints) in their
-- introducing migrations, so this migration only fills the missing gaps.
-- A full UNIQUE index is intentional: revoked/accepted rows remain part of
-- the credential history and must not permit a hash to be reused while an
-- old row is still present.

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_token_token_hash
  ON api_token(token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_token_hash
  ON session(token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invitation_token_hash
  ON invitation(token_hash);

-- Invitation admission asks for the newest unaccepted invitation for an
-- email.  Both SQLite and PostgreSQL support this partial index shape, and
-- the ordering matches InvitationService.findPendingByEmail().
CREATE INDEX IF NOT EXISTS idx_invitation_pending_email
  ON invitation(workspace_id, email, created_at DESC)
  WHERE accepted_at IS NULL;
