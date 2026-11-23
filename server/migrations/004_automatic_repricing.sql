ALTER TABLE public.p2p_live_control
  ADD COLUMN IF NOT EXISTS auto_repricing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS scan_interval_ms INTEGER NOT NULL DEFAULT 5000
    CHECK (scan_interval_ms BETWEEN 5000 AND 300000),
  ADD COLUMN IF NOT EXISTS scan_interval_source TEXT NOT NULL DEFAULT 'environment'
    CHECK (scan_interval_source IN ('environment', 'dashboard'));

CREATE TABLE IF NOT EXISTS public.p2p_ad_repricing_configs (
  ad_id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL CHECK (token_id IN ('BTC', 'USDT')),
  currency_id TEXT NOT NULL CHECK (currency_id = 'NGN'),
  side SMALLINT NOT NULL CHECK (side IN (0, 1)),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  reference_price NUMERIC(30, 10) CHECK (reference_price IS NULL OR reference_price > 0),
  minimum_margin_percent NUMERIC(8, 4)
    CHECK (minimum_margin_percent IS NULL OR minimum_margin_percent BETWEEN 0 AND 100),
  competitive_offset_ngn NUMERIC(30, 10) NOT NULL DEFAULT 1
    CHECK (competitive_offset_ngn >= 0),
  minimum_difference_ngn NUMERIC(30, 10) NOT NULL DEFAULT 1
    CHECK (minimum_difference_ngn > 0),
  minimum_competitor_liquidity_ngn NUMERIC(30, 10) NOT NULL DEFAULT 0
    CHECK (minimum_competitor_liquidity_ngn >= 0),
  min_recent_order_num INTEGER NOT NULL DEFAULT 10 CHECK (min_recent_order_num >= 0),
  min_recent_execute_rate NUMERIC(6, 2) NOT NULL DEFAULT 80
    CHECK (min_recent_execute_rate BETWEEN 0 AND 100),
  pause_reason TEXT,
  paused_at TIMESTAMPTZ,
  pricing_parameters_updated_at TIMESTAMPTZ,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.p2p_scan_runs
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER NOT NULL DEFAULT 0
    CHECK (duration_ms >= 0),
  ADD COLUMN IF NOT EXISTS api_call_count INTEGER NOT NULL DEFAULT 0
    CHECK (api_call_count >= 0),
  ADD COLUMN IF NOT EXISTS average_api_latency_ms INTEGER NOT NULL DEFAULT 0
    CHECK (average_api_latency_ms >= 0),
  ADD COLUMN IF NOT EXISTS updated_count INTEGER NOT NULL DEFAULT 0
    CHECK (updated_count >= 0),
  ADD COLUMN IF NOT EXISTS failed_update_count INTEGER NOT NULL DEFAULT 0
    CHECK (failed_update_count >= 0),
  ADD COLUMN IF NOT EXISTS rate_limit_warnings INTEGER NOT NULL DEFAULT 0
    CHECK (rate_limit_warnings >= 0);

ALTER TABLE public.p2p_price_proposals
  ADD COLUMN IF NOT EXISTS execution_status TEXT NOT NULL DEFAULT 'dry_run'
    CHECK (execution_status IN ('dry_run', 'updated', 'skipped', 'failed', 'paused')),
  ADD COLUMN IF NOT EXISTS execution_message TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_p2p_ad_repricing_enabled
  ON public.p2p_ad_repricing_configs(enabled, ad_id);
CREATE INDEX IF NOT EXISTS idx_p2p_price_proposals_execution_status
  ON public.p2p_price_proposals(execution_status, created_at DESC);
