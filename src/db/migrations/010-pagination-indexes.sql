-- Keyset-pagination support. Every index ends in the immutable ID used as
-- the deterministic tie-breaker by the matching service query.
CREATE INDEX IF NOT EXISTS idx_board_project_created_id
  ON board(project_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_project_created_id
  ON project(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_card_column_archived_position_id
  ON card(column_id, archived, position, id);
CREATE INDEX IF NOT EXISTS idx_card_updated_id
  ON card(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_document_project_title_id
  ON document(project_id, title, id);
CREATE INDEX IF NOT EXISTS idx_document_version_document_version_id
  ON document_version(document_id, version DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_workspace_created_id
  ON agent(workspace_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_role_workspace_rank_id
  ON role(workspace_id, rank DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_invitation_workspace_created_id
  ON invitation(workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_token_principal_created_id
  ON api_token(principal_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_workspace_created_id
  ON audit_log(workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_event_project_created_id
  ON event(project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_kb_created_id
  ON knowledge_base(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_kb_entity_kb_name_id
  ON kb_entity(kb_id, name, id);
CREATE INDEX IF NOT EXISTS idx_kb_entity_updated_id
  ON kb_entity(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_kb_fact_kb_created_id
  ON kb_fact(kb_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_label_board_name_id
  ON label(board_id, name, id);
CREATE INDEX IF NOT EXISTS idx_work_link_card_created_id
  ON card_work_link(card_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_agent_workspace_operator_created_id
  ON agent(workspace_id, operator_user_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_project_kb_project_kb
  ON project_knowledge_base(project_id, kb_id);
CREATE INDEX IF NOT EXISTS idx_kb_relation_kb_created_id
  ON kb_relation(kb_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_kb_fact_entity_created_id
  ON kb_fact(entity_id, created_at, id);
