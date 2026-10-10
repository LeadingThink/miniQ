-- A queued message the user steered into the running turn. The flag moves
-- with the message from the queue into history so the timeline can render it
-- inline in the interrupted turn instead of as a new turn.
ALTER TABLE queued_messages ADD COLUMN steered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN steered INTEGER NOT NULL DEFAULT 0;
