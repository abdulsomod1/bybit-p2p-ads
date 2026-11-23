CREATE TABLE IF NOT EXISTS p2p_live_control (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  live_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  emergency_stopped BOOLEAN NOT NULL DEFAULT FALSE,
  permissions_verified_at TIMESTAMPTZ,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO p2p_live_control (id, live_enabled, emergency_stopped)
VALUES (1, FALSE, FALSE)
ON CONFLICT (id) DO NOTHING;
