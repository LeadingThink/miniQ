-- NULL is retained for pre-migration/imported messages whose phase is unknown.
ALTER TABLE messages ADD COLUMN assistant_kind TEXT
  CHECK (assistant_kind IS NULL OR
    (role = 'assistant' AND assistant_kind IN ('commentary', 'final', 'interrupted')));
