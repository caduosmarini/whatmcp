ALTER TABLE thread_projection_state ADD COLUMN desired_revision TEXT NOT NULL DEFAULT 'v1';
ALTER TABLE thread_projection_state ADD COLUMN pending_audio INTEGER NOT NULL DEFAULT 0;
