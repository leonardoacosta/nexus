CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  machine TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL,
  last_activity TEXT NOT NULL,
  ended_at TEXT,
  pid INTEGER,
  cwd TEXT
);

CREATE TABLE IF NOT EXISTS health_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  cpu_percent REAL,
  ram_percent REAL,
  disk_percent REAL,
  docker_containers INTEGER,
  raw_json TEXT
);

CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  metadata TEXT
);
