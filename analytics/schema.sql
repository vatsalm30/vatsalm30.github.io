CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,          -- unix ms (server time)
  type        TEXT    NOT NULL,          -- pageview | click | section | engage | pixel
  visitor     TEXT,                      -- random id kept in visitor's localStorage
  session     TEXT,                      -- random id per tab session
  path        TEXT,
  referrer    TEXT,
  target      TEXT,                      -- click: element label / section id
  href        TEXT,                      -- click: link destination
  duration_ms INTEGER,                   -- engage: active time on page
  scroll_pct  INTEGER,                   -- engage: max scroll depth
  country     TEXT,
  city        TEXT,
  device      TEXT,
  browser     TEXT,
  os          TEXT,
  screen      TEXT,
  utm_source  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session);
