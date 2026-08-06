-- WhatMCP archive schema.
--
-- This store is an ARCHIVE, not a cache. WhatsApp Desktop prunes its own local
-- database and can be emptied entirely by unlinking the device, so after a while
-- these tables hold messages that exist nowhere else on this machine. Nothing in
-- the indexer deletes a message row; that property is the whole point.
--
-- No PRAGMAs here. journal_mode is database-level and SQLite refuses to change it
-- inside a transaction, which is where migrations run; foreign_keys is
-- per-connection and would be silently lost. Both are set in openStore().

-- A person. Keyed by WhatsApp's own identifier (a phone JID or an @lid), so the
-- key survives a local store wipe and re-sync.
CREATE TABLE IF NOT EXISTS senders (
  id            TEXT PRIMARY KEY,      -- jid / @lid, or 'me'
  display_name  TEXT,                  -- best name seen so far
  phone         TEXT,                  -- digits, when the id is a phone JID
  is_self       INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,      -- when WhatMCP first captured this person
  last_seen_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_senders_name ON senders (display_name);

-- A conversation: 1:1 or group.
CREATE TABLE IF NOT EXISTS threads (
  id            TEXT PRIMARY KEY,      -- contact JID / group JID
  title         TEXT,
  kind          TEXT NOT NULL,         -- 'dm' | 'group'
  msg_count     INTEGER NOT NULL DEFAULT 0,
  first_ts      INTEGER,               -- unix seconds, UTC
  last_ts       INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_last ON threads (last_ts DESC);

-- Messages.
--
-- id is "{thread_jid}:{stanza_id}" rather than WhatsApp's Z_PK. Z_PK is a local
-- rowid: wipe the app's store and re-link the device and every Z_PK changes, which
-- would make a re-sync duplicate the entire archive. The stanza id is the
-- wire-level message identifier and survives that, so re-syncing an emptied
-- WhatsApp against a full archive is idempotent.
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES threads(id),
  sender_id     TEXT REFERENCES senders(id),
  ts            INTEGER NOT NULL,      -- unix seconds, UTC
  text          TEXT,                  -- NULL for media with no caption
  is_from_me    INTEGER NOT NULL DEFAULT 0,
  kind          TEXT,                  -- 'text' | 'image' | 'audio' | ...
  reply_to      TEXT,                  -- stanza id of the parent, if any
  stanza_id     TEXT,
  source_pk     INTEGER,               -- Z_PK at capture time; debugging only
  first_seen_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_thread_ts ON messages (thread_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_ts        ON messages (ts);
CREATE INDEX IF NOT EXISTS idx_messages_sender    ON messages (sender_id, ts);

-- Conversation windows: the retrieval unit.
--
-- A single message is usually unsearchable and unembeddable ("ok", "lol", "yeah").
-- A window is a burst of consecutive messages in one thread with no silence longer
-- than the gap threshold, rendered with speaker labels. Windows are what FTS5
-- indexes and what gets embedded.
CREATE TABLE IF NOT EXISTS windows (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id    TEXT NOT NULL REFERENCES threads(id),
  start_ts     INTEGER NOT NULL,
  end_ts       INTEGER NOT NULL,
  msg_count    INTEGER NOT NULL,
  speakers     TEXT,                   -- comma-joined display names
  text         TEXT NOT NULL,          -- "Name: line\nName: line"
  first_msg_id TEXT,
  last_msg_id  TEXT,
  content_hash TEXT                    -- identity of the embedded payload
);

CREATE INDEX IF NOT EXISTS idx_windows_thread ON windows (thread_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_windows_ts     ON windows (start_ts);
CREATE INDEX IF NOT EXISTS idx_windows_hash   ON windows (content_hash);

-- BM25 over window text. Contentless (content='') so the corpus isn't stored
-- twice; we join back to windows on rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS windows_fts USING fts5 (
  text,
  speakers,
  content = '',
  tokenize = "unicode61 remove_diacritics 2"
);

-- Dense vectors, keyed by content_hash rather than by windows.id.
--
-- windows.id is AUTOINCREMENT and window rows are dropped and recreated whenever a
-- thread's boundaries shift, so anything keyed by id would be orphaned on the next
-- sync. Hashing the rendered payload means an unchanged window keeps its vector,
-- and identical bursts across the corpus share one.
--
-- Deliberately NO foreign key to windows: this table must outlive the rows it
-- describes. Window boundaries legitimately oscillate as messages arrive, so
-- today's orphan is tomorrow's cache hit.
CREATE TABLE IF NOT EXISTS window_vectors (
  content_hash TEXT    NOT NULL,
  -- e.g. 'openai/text-embedding-3-small@1536'. Compound-keyed with content_hash so
  -- two models can coexist in one file: swapping models becomes a config change
  -- rather than a full re-embed, and mixing two vector spaces is impossible.
  model        TEXT    NOT NULL,
  dim          INTEGER NOT NULL,
  truncated    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  vec          BLOB    NOT NULL,       -- dim * 4 bytes, little-endian f32, L2-normalized
  PRIMARY KEY (content_hash, model)
);

-- One row, id = 'whatsapp'. Watermark for incremental extraction.
CREATE TABLE IF NOT EXISTS sync_state (
  id             TEXT PRIMARY KEY,
  last_source_pk INTEGER NOT NULL DEFAULT 0,
  last_ts        INTEGER,
  last_run_at    INTEGER,
  msg_count      INTEGER NOT NULL DEFAULT 0,
  full_runs      INTEGER NOT NULL DEFAULT 0
);
