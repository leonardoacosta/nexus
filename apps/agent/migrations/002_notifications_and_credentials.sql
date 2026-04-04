-- Notification buffer table
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  project TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  sent_at TEXT
);

-- Credential pool table
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  value_encrypted TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  leased_by TEXT,
  leased_at TEXT,
  cooldown_until TEXT
);
