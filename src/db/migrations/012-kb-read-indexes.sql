-- Bounded KB browse and context lookup support. Every ordered index ends in
-- the immutable ID used by its keyset cursor or adjacency tie-breaker.
CREATE INDEX IF NOT EXISTS idx_project_kb_kb_project
  ON project_knowledge_base(kb_id, project_id);
CREATE INDEX IF NOT EXISTS idx_kb_fact_updated_id
  ON kb_fact(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_kb_fact_category_updated_id
  ON kb_fact(category, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_kb_entity_type_name_id
  ON kb_entity(type, name, id);
CREATE INDEX IF NOT EXISTS idx_kb_entity_identifier_kb_id
  ON kb_entity(identifier, kb_id, id);
CREATE INDEX IF NOT EXISTS idx_kb_relation_source_created_id
  ON kb_relation(source_entity_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_kb_relation_target_created_id
  ON kb_relation(target_entity_id, created_at, id);
