-- File: src/db/migrations/011-workflow-lane-roles.sql
-- MUS-77: persist workflow semantics independently from presentation names.
-- NULL is intentional for legacy boards that require operator classification.
ALTER TABLE "column"
  ADD COLUMN workflow_role TEXT
    CHECK (workflow_role IS NULL OR workflow_role IN ('backlog', 'ready', 'active', 'review', 'terminal'));

CREATE INDEX IF NOT EXISTS idx_column_workflow_role
  ON "column" (board_id, workflow_role);

