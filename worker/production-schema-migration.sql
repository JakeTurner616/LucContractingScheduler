ALTER TABLE jobs ADD COLUMN customer_name TEXT;
ALTER TABLE jobs ADD COLUMN customer_email TEXT;

CREATE TABLE IF NOT EXISTS job_completion_documents (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  customer_email TEXT,
  work_performed TEXT,
  materials_used TEXT,
  customer_notes TEXT,
  work_image_data_url TEXT,
  signature_name TEXT NOT NULL,
  signature_data_url TEXT NOT NULL,
  signed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by_user_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);
