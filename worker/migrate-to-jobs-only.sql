ALTER TABLE jobs ADD COLUMN scheduled_start TEXT;
ALTER TABLE jobs ADD COLUMN scheduled_end TEXT;
ALTER TABLE jobs ADD COLUMN internal_notes TEXT;

CREATE TABLE IF NOT EXISTS job_assignments (
  job_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (job_id, user_id),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS calendar_feeds_new (
  id TEXT PRIMARY KEY,
  feed_type TEXT NOT NULL CHECK (feed_type IN ('supervisor_all', 'worker')),
  user_id TEXT,
  token TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_accessed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT INTO calendar_feeds_new (id, feed_type, user_id, token, active, created_at, last_accessed_at)
SELECT id, 'worker', user_id, token, active, created_at, last_accessed_at
FROM calendar_feeds;

DROP TABLE calendar_feeds;
ALTER TABLE calendar_feeds_new RENAME TO calendar_feeds;
