-- Persist a database-assigned order for activity replay. ULIDs are unique but
-- their random component is not monotonic within one millisecond, so lexical
-- ID comparison cannot define a lossless Last-Event-ID successor relation.

CREATE TABLE IF NOT EXISTS event_order_sequence (
  id         INTEGER PRIMARY KEY,
  next_order BIGINT NOT NULL
);

ALTER TABLE event ADD COLUMN event_order BIGINT;

-- Existing rows receive a deterministic order before new writes begin using
-- the sequence. created_at is the historical timestamp; id is only the
-- deterministic tie-breaker for already persisted rows.
UPDATE event
   SET event_order = (
     SELECT COUNT(*)
       FROM event AS prior
      WHERE prior.created_at < event.created_at
         OR (prior.created_at = event.created_at AND prior.id <= event.id)
   );

INSERT INTO event_order_sequence (id, next_order)
SELECT 1, COALESCE(MAX(event_order), 0) + 1
  FROM event;

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_order ON event(event_order);
CREATE INDEX IF NOT EXISTS idx_event_project_order ON event(project_id, event_order);
