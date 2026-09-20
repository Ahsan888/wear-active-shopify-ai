CREATE TABLE IF NOT EXISTS browser_context (
  order_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_source_url TEXT,
  fbp TEXT,
  fbc TEXT,
  client_user_agent TEXT,
  external_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meta_events (
  event_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  source_name TEXT,
  state TEXT NOT NULL,
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  meta_status INTEGER,
  meta_trace_id TEXT,
  sent_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_meta_events_order_id ON meta_events(order_id);
CREATE INDEX IF NOT EXISTS idx_meta_events_state ON meta_events(state);

CREATE TABLE IF NOT EXISTS browser_events (
  event_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  state TEXT NOT NULL,
  meta_status INTEGER,
  meta_trace_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_browser_events_name ON browser_events(event_name);
