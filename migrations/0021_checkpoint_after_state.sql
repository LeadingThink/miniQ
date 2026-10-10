-- File state right after the checkpointed tool call finished:
-- 'absent' or 'sha256:<hex>'. NULL means it was not recorded.
ALTER TABLE checkpoints ADD COLUMN after_state TEXT;
