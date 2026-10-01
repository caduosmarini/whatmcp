-- Keyset pagination over individual messages needs a stable tie-breaker when
-- several messages share one second. These indexes support global and per-chat
-- feeds without sorting the remainder of a large date range for every page.
DROP INDEX IF EXISTS idx_messages_ts;
DROP INDEX IF EXISTS idx_messages_thread_ts;
CREATE INDEX idx_messages_ts_id ON messages (ts, id);
CREATE INDEX idx_messages_thread_ts_id ON messages (thread_id, ts, id);
