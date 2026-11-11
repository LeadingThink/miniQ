-- Replace the column to extend its CHECK without rebuilding the messages table
-- through DROP TABLE, which would cascade deletes into memory evidence.
-- ALTER TABLE preserves message rowids and all foreign-key references.
ALTER TABLE messages ADD COLUMN assistant_kind_next TEXT
  CHECK (assistant_kind_next IS NULL OR
    (role = 'assistant' AND assistant_kind_next IN ('commentary', 'interim', 'final', 'interrupted')));
UPDATE messages SET assistant_kind_next = assistant_kind;
ALTER TABLE messages DROP COLUMN assistant_kind;
ALTER TABLE messages RENAME COLUMN assistant_kind_next TO assistant_kind;
