ALTER TABLE messages ADD COLUMN pasted_text_json TEXT NOT NULL DEFAULT 'null';
ALTER TABLE queued_messages ADD COLUMN pasted_text_json TEXT NOT NULL DEFAULT 'null';
