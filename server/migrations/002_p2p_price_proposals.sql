CREATE TABLE IF NOT EXISTS p2p_scan_runs (
  id UUID PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  proposal_count INTEGER NOT NULL CHECK (proposal_count >= 0),
  large_change_count INTEGER NOT NULL CHECK (large_change_count >= 0)
);

CREATE TABLE IF NOT EXISTS p2p_price_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID NOT NULL REFERENCES p2p_scan_runs(id),
  token_id TEXT NOT NULL CHECK (token_id IN ('BTC', 'USDT')),
  currency_id TEXT NOT NULL CHECK (currency_id = 'NGN'),
  side SMALLINT NOT NULL CHECK (side IN (0, 1)),
  own_ad_id TEXT NOT NULL,
  current_price NUMERIC(30, 10) NOT NULL,
  competitor_ad_id TEXT NOT NULL,
  competitor_nickname TEXT NOT NULL DEFAULT '',
  competitor_auth_tags TEXT[] NOT NULL DEFAULT '{}',
  proposed_price NUMERIC(30, 10) NOT NULL,
  price_delta_ngn NUMERIC(30, 10) NOT NULL,
  large_change BOOLEAN NOT NULL,
  matching_payment_types TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_p2p_price_proposals_created_at
  ON p2p_price_proposals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_p2p_price_proposals_scan_id
  ON p2p_price_proposals(scan_id);
CREATE INDEX IF NOT EXISTS idx_p2p_scan_runs_started_at
  ON p2p_scan_runs(started_at DESC);
