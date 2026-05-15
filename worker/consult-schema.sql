CREATE TABLE IF NOT EXISTS schedule_requests (
  id TEXT PRIMARY KEY,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  service_type TEXT,
  preferred_date TEXT,
  preferred_time TEXT,
  address TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  source TEXT
);
