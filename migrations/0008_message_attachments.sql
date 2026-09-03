ALTER TABLE messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE queued_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
