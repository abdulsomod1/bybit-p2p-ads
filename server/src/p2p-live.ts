import type { PoolClient } from "pg";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { pool } from "./db.js";
import { BybitRequestError } from "./bybit.js";
import {
  buildAdUpdatePayload,
  calculateMinimumProfitablePrice,
  fetchOwnAds,
  fetchP2PAdDetails,
  fetchP2PUserPayments,
  ngnUnits,
  updateP2PAd,
  verifyP2PLivePermissions,
  type P2PAd,
  type P2PPayment,
  type P2PPriceProposal,
} from "./p2p.js";
import { getP2PProposalById, type StoredP2PProposal } from "./p2p-monitor.js";
import {
  checkDistributedRateLimit,
  releaseAdUpdateLock,
  serverInstanceId,
  tryAcquireAdUpdateLock,
} from "./redis.js";

const proposalMaximumAgeMs = config.p2pMaximumMarketDataAgeMs;
const liveAdIdPattern = /^\d{1,32}$/;

export type P2PLiveLimits = {
  minPriceNgn: string;
  maxPriceNgn: string;
  maxChangeNgn: string;
};

export type P2PLiveStatus = {
  mode: "dry_run" | "live";
  emergencyStopped: boolean;
  automaticRepricingEnabled: boolean;
  scanIntervalMs: number;
  permissionsVerifiedAt: string | null;
  minPriceNgn: string | null;
  maxPriceNgn: string | null;
  maxChangeNgn: string;
  limitsConfigured: boolean;
};

export class P2PLiveError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly pauseAdvertisement = false,
  ) {
    super(message);
    this.name = "P2PLiveError";
  }
}

function configuredLimits(): P2PLiveLimits | null {
  const { p2pLiveMinPriceNgn, p2pLiveMaxPriceNgn, p2pLiveMaxChangeNgn } = config;
  if (!p2pLiveMinPriceNgn || !p2pLiveMaxPriceNgn || !p2pLiveMaxChangeNgn) return null;
  try {
    const min = ngnUnits(p2pLiveMinPriceNgn, "P2P live minimum price");
    const max = ngnUnits(p2pLiveMaxPriceNgn, "P2P live maximum price");
    const change = ngnUnits(p2pLiveMaxChangeNgn, "P2P live maximum price change");
    if (min <= 0n || max < min || change <= 0n) return null;
    return {
      minPriceNgn: p2pLiveMinPriceNgn,
      maxPriceNgn: p2pLiveMaxPriceNgn,
      maxChangeNgn: p2pLiveMaxChangeNgn,
    };
  } catch {
    return null;
  }
}

function requireConfiguredLimits(): P2PLiveLimits {
  const limits = configuredLimits();
  if (!limits) {
    throw new P2PLiveError("Set valid P2P_LIVE_MIN_PRICE_NGN, P2P_LIVE_MAX_PRICE_NGN, and P2P_LIVE_MAX_CHANGE_NGN values before enabling live updates", 503);
  }
  return limits;
}

function assertCredentialsConfigured(): void {
  if (!config.bybitApiKey || !config.bybitApiSecret) {
    throw new P2PLiveError("BYBIT_API_KEY and BYBIT_API_SECRET are required", 503);
  }
}

type LiveControlRow = {
  live_enabled: boolean;
  emergency_stopped: boolean;
  auto_repricing_enabled: boolean;
  scan_interval_ms: number;
  permissions_verified_at: Date | string | null;
};

function mapControl(row: LiveControlRow, limits: P2PLiveLimits | null): P2PLiveStatus {
  return {
    mode: row.live_enabled && !row.emergency_stopped ? "live" : "dry_run",
    emergencyStopped: row.emergency_stopped,
    automaticRepricingEnabled: row.auto_repricing_enabled,
    scanIntervalMs: Number(row.scan_interval_ms),
    permissionsVerifiedAt: row.permissions_verified_at
      ? new Date(row.permissions_verified_at).toISOString()
      : null,
    minPriceNgn: limits?.minPriceNgn ?? null,
    maxPriceNgn: limits?.maxPriceNgn ?? null,
    maxChangeNgn: limits?.maxChangeNgn ?? config.p2pLiveMaxChangeNgn,
    limitsConfigured: Boolean(limits),
  };
}

export async function getP2PLiveStatus(): Promise<P2PLiveStatus> {
  const result = await pool.query(
    `SELECT live_enabled, emergency_stopped, auto_repricing_enabled,
            scan_interval_ms, permissions_verified_at
     FROM public.p2p_live_control
     WHERE id = 1`,
  );
  const row = result.rows[0] as LiveControlRow | undefined;
  if (!row) throw new Error("P2P live control row is missing");
  return mapControl(row, configuredLimits());
}

async function insertAuditEvent(
  client: PoolClient,
  requestId: string | undefined,
  actor: string,
  action: string,
  result: string,
  details: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO public.audit_events (request_id, actor, action, result, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [requestId ?? null, actor, action, result, JSON.stringify(details)],
  );
}

export async function resetP2PLiveModeAtStartup(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT live_enabled, emergency_stopped, auto_repricing_enabled
       FROM public.p2p_live_control
       WHERE id = 1
       FOR UPDATE`,
    );
    const row = selected.rows[0] as {
      live_enabled: boolean;
      emergency_stopped: boolean;
      auto_repricing_enabled: boolean;
    } | undefined;
    if (!row) throw new Error("P2P live control row is missing");
    await client.query(
      `UPDATE public.p2p_live_control
       SET live_enabled = FALSE,
           auto_repricing_enabled = FALSE,
           emergency_stopped = CASE WHEN live_enabled THEN TRUE ELSE emergency_stopped END,
           scan_interval_ms = CASE
             WHEN scan_interval_source = 'environment' THEN $1
             ELSE scan_interval_ms
           END,
           updated_by = 'system',
           updated_at = NOW()
       WHERE id = 1`,
      [config.p2pScanIntervalMs],
    );
    if (row.live_enabled || row.auto_repricing_enabled) {
      await insertAuditEvent(client, undefined, "system", "p2p_live_mode_reset", "stopped", {
        reason: "Server startup always disarms live updates and automatic repricing",
      });
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error({
        errorName: rollbackError instanceof Error ? rollbackError.name : "UnknownError",
      }, "Failed to roll back P2P live-mode startup reset");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function enableP2PLiveMode(
  actor: string,
  requestId?: string,
): Promise<P2PLiveStatus> {
  let limits: P2PLiveLimits;
  let access: { ownAdCount: number; paymentMethodCount: number };
  try {
    limits = requireConfiguredLimits();
    assertCredentialsConfigured();
    access = await verifyP2PLivePermissions();
  } catch (error) {
    const auditClient = await pool.connect();
    try {
      await insertAuditEvent(
        auditClient,
        requestId,
        actor,
        "p2p_live_permission_check_failed",
        "failed",
        { error: safeErrorMessage(error), failedAt: new Date().toISOString() },
      );
    } finally {
      auditClient.release();
    }
    throw error;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE public.p2p_live_control
       SET live_enabled = TRUE,
           auto_repricing_enabled = FALSE,
           emergency_stopped = FALSE,
           permissions_verified_at = NOW(),
           updated_by = $1,
           updated_at = NOW()
       WHERE id = 1
       RETURNING live_enabled, emergency_stopped, auto_repricing_enabled,
                 scan_interval_ms, permissions_verified_at`,
      [actor],
    );
    const row = updated.rows[0] as LiveControlRow | undefined;
    if (!row) throw new Error("P2P live control row is missing");
    await insertAuditEvent(client, requestId, actor, "p2p_live_mode_enabled", "success", {
      permissionCheck: "read-write FiatP2P Advertising; no P2P order or Wallet permissions",
      ownAdCount: access.ownAdCount,
      paymentMethodCount: access.paymentMethodCount,
      limits,
    });
    await client.query("COMMIT");
    logger.warn({ actor }, "Live P2P advertisement updates enabled");
    return mapControl(row, limits);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error({
        errorName: rollbackError instanceof Error ? rollbackError.name : "UnknownError",
      }, "Failed to roll back P2P live-mode enable");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function stopP2PLiveMode(
  actor: string,
  requestId?: string,
): Promise<P2PLiveStatus> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE public.p2p_live_control
       SET live_enabled = FALSE,
           auto_repricing_enabled = FALSE,
           emergency_stopped = TRUE,
           updated_by = $1,
           updated_at = NOW()
       WHERE id = 1
       RETURNING live_enabled, emergency_stopped, auto_repricing_enabled,
                 scan_interval_ms, permissions_verified_at`,
      [actor],
    );
    const row = updated.rows[0] as LiveControlRow | undefined;
    if (!row) throw new Error("P2P live control row is missing");
    await insertAuditEvent(client, requestId, actor, "p2p_emergency_stop", "stopped", {
      message: "Live advertisement updates disabled by administrator",
    });
    await client.query("COMMIT");
    logger.warn({ actor }, "P2P emergency STOP activated");
    return mapControl(row, configuredLimits());
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error({
        errorName: rollbackError instanceof Error ? rollbackError.name : "UnknownError",
      }, "Failed to roll back P2P emergency STOP");
    }
    throw error;
  } finally {
    client.release();
  }
}

export type P2PAdRepricingSettings = {
  adId: string;
  tokenId: "BTC" | "USDT";
  currencyId: "NGN";
  side: "0" | "1";
  enabled: boolean;
  referencePrice: string | null;
  minimumMarginPercent: string | null;
  competitiveOffsetNgn: string;
  minimumDifferenceNgn: string;
  minimumCompetitorLiquidityNgn: string;
  minRecentOrderNum: number;
  minRecentExecuteRate: string;
  pricingParametersUpdatedAt: string | null;
  pauseReason: string | null;
};

export type P2PAdRepricingSettingsInput = Omit<
  P2PAdRepricingSettings,
  "pricingParametersUpdatedAt" | "pauseReason"
>;

export async function listP2PAdRepricingSettings(): Promise<P2PAdRepricingSettings[]> {
  const result = await pool.query(
    `SELECT ad_id, token_id, currency_id, side, enabled, reference_price,
            minimum_margin_percent, competitive_offset_ngn, minimum_difference_ngn,
            minimum_competitor_liquidity_ngn, min_recent_order_num,
            min_recent_execute_rate, pricing_parameters_updated_at, pause_reason
     FROM public.p2p_ad_repricing_configs
     ORDER BY ad_id`,
  );
  return result.rows.map((row) => ({
    adId: row.ad_id as string,
    tokenId: row.token_id as "BTC" | "USDT",
    currencyId: row.currency_id as "NGN",
    side: row.side === 0 ? "0" : "1",
    enabled: row.enabled as boolean,
    referencePrice: row.reference_price === null ? null : String(row.reference_price),
    minimumMarginPercent: row.minimum_margin_percent === null
      ? null
      : String(row.minimum_margin_percent),
    competitiveOffsetNgn: String(row.competitive_offset_ngn),
    minimumDifferenceNgn: String(row.minimum_difference_ngn),
    minimumCompetitorLiquidityNgn: String(row.minimum_competitor_liquidity_ngn),
    minRecentOrderNum: Number(row.min_recent_order_num),
    minRecentExecuteRate: String(row.min_recent_execute_rate),
    pricingParametersUpdatedAt: row.pricing_parameters_updated_at
      ? new Date(row.pricing_parameters_updated_at as Date).toISOString()
      : null,
    pauseReason: row.pause_reason as string | null,
  }));
}

export async function saveP2PAdRepricingSettings(
  actor: string,
  input: P2PAdRepricingSettingsInput,
  requestId?: string,
): Promise<P2PAdRepricingSettings> {
  if (!liveAdIdPattern.test(input.adId)
    || !["BTC", "USDT"].includes(input.tokenId)
    || input.currencyId !== "NGN"
    || (input.side !== "0" && input.side !== "1")) {
    throw new P2PLiveError("Advertisement identity is invalid");
  }
  try {
    if (input.referencePrice !== null) {
      if (ngnUnits(input.referencePrice, "Advertisement reference price") <= 0n) {
        throw new P2PLiveError("Reference price must be greater than zero");
      }
    }
    if (input.minimumMarginPercent !== null) {
      if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(input.minimumMarginPercent)
        || Number(input.minimumMarginPercent) > 100) {
        throw new P2PLiveError("Minimum margin must be between 0 and 100 percent with at most 4 decimals");
      }
    }
    if (ngnUnits(input.competitiveOffsetNgn, "Competitive offset") < 0n
      || ngnUnits(input.minimumDifferenceNgn, "Minimum price difference") <= 0n
      || ngnUnits(input.minimumCompetitorLiquidityNgn, "Minimum competitor liquidity") < 0n) {
      throw new P2PLiveError("Advertisement repricing thresholds are invalid");
    }
    if (!Number.isSafeInteger(input.minRecentOrderNum) || input.minRecentOrderNum < 0
      || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(input.minRecentExecuteRate)
      || Number(input.minRecentExecuteRate) > 100) {
      throw new P2PLiveError("Competitor activity thresholds are invalid");
    }
  } catch (error) {
    if (error instanceof P2PLiveError) throw error;
    throw new P2PLiveError(error instanceof Error ? error.message : "Advertisement repricing settings are invalid");
  }

  if (input.enabled && (!input.referencePrice || input.minimumMarginPercent === null)) {
    throw new P2PLiveError("Set and confirm this ad's reference price and minimum margin before enabling it");
  }
  if (input.enabled && input.side === "0" && Number(input.minimumMarginPercent) >= 100) {
    throw new P2PLiveError("A buy-ad minimum margin must be less than 100 percent");
  }
  const ad = (await fetchOwnAds(input.tokenId, input.side)).find((candidate) =>
    candidate.id === input.adId
    && candidate.tokenId === input.tokenId
    && candidate.currencyId === input.currencyId
    && candidate.side === input.side,
  );
  if (!ad) throw new P2PLiveError("Advertisement is not present in the authenticated Bybit account", 404);
  if (input.enabled && (ad.status !== 10 || ad.priceType !== "0")) {
    throw new P2PLiveError("Only active fixed-price advertisements can be enabled for repricing");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`p2p-live-ad:${input.adId}`]);
    const saved = await client.query(
      `INSERT INTO public.p2p_ad_repricing_configs (
        ad_id, token_id, currency_id, side, enabled, reference_price,
        minimum_margin_percent, competitive_offset_ngn, minimum_difference_ngn,
        minimum_competitor_liquidity_ngn, min_recent_order_num, min_recent_execute_rate,
        pricing_parameters_updated_at, pause_reason, paused_at, updated_by, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NULL, NULL, $13, NOW())
      ON CONFLICT (ad_id) DO UPDATE SET
        token_id = EXCLUDED.token_id,
        currency_id = EXCLUDED.currency_id,
        side = EXCLUDED.side,
        enabled = EXCLUDED.enabled,
        reference_price = EXCLUDED.reference_price,
        minimum_margin_percent = EXCLUDED.minimum_margin_percent,
        competitive_offset_ngn = EXCLUDED.competitive_offset_ngn,
        minimum_difference_ngn = EXCLUDED.minimum_difference_ngn,
        minimum_competitor_liquidity_ngn = EXCLUDED.minimum_competitor_liquidity_ngn,
        min_recent_order_num = EXCLUDED.min_recent_order_num,
        min_recent_execute_rate = EXCLUDED.min_recent_execute_rate,
        pricing_parameters_updated_at = NOW(),
        pause_reason = NULL,
        paused_at = NULL,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
      RETURNING ad_id, token_id, currency_id, side, enabled, reference_price,
                minimum_margin_percent, competitive_offset_ngn, minimum_difference_ngn,
                minimum_competitor_liquidity_ngn, min_recent_order_num,
                min_recent_execute_rate, pricing_parameters_updated_at, pause_reason`,
      [
        input.adId,
        input.tokenId,
        input.currencyId,
        Number(input.side),
        input.enabled,
        input.referencePrice,
        input.minimumMarginPercent,
        input.competitiveOffsetNgn,
        input.minimumDifferenceNgn,
        input.minimumCompetitorLiquidityNgn,
        input.minRecentOrderNum,
        input.minRecentExecuteRate,
        actor,
      ],
    );
    const row = saved.rows[0];
    await insertAuditEvent(client, requestId, actor, "p2p_ad_repricing_config_saved", "success", {
      adId: input.adId,
      enabled: input.enabled,
      referencePrice: input.referencePrice,
      minimumMarginPercent: input.minimumMarginPercent,
      competitiveOffsetNgn: input.competitiveOffsetNgn,
      minimumDifferenceNgn: input.minimumDifferenceNgn,
      pricingParametersUpdatedAt: row.pricing_parameters_updated_at,
    });
    await client.query("COMMIT");
    return {
      adId: row.ad_id as string,
      tokenId: row.token_id as "BTC" | "USDT",
      currencyId: row.currency_id as "NGN",
      side: row.side === 0 ? "0" : "1",
      enabled: row.enabled as boolean,
      referencePrice: row.reference_price === null ? null : String(row.reference_price),
      minimumMarginPercent: row.minimum_margin_percent === null
        ? null
        : String(row.minimum_margin_percent),
      competitiveOffsetNgn: String(row.competitive_offset_ngn),
      minimumDifferenceNgn: String(row.minimum_difference_ngn),
      minimumCompetitorLiquidityNgn: String(row.minimum_competitor_liquidity_ngn),
      minRecentOrderNum: Number(row.min_recent_order_num),
      minRecentExecuteRate: String(row.min_recent_execute_rate),
      pricingParametersUpdatedAt: row.pricing_parameters_updated_at
        ? new Date(row.pricing_parameters_updated_at as Date).toISOString()
        : null,
      pauseReason: row.pause_reason as string | null,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error({
        errorName: rollbackError instanceof Error ? rollbackError.name : "UnknownError",
      }, "Failed to roll back P2P ad repricing settings");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function setP2PAutomaticRepricing(
  actor: string,
  enabled: boolean,
  scanIntervalMs: number,
  requestId?: string,
): Promise<P2PLiveStatus> {
  if (!Number.isSafeInteger(scanIntervalMs) || scanIntervalMs < 5_000 || scanIntervalMs > 300_000) {
    throw new P2PLiveError("Scan interval must be between 5000 and 300000 milliseconds");
  }
  if (enabled) {
    if (!config.p2pAutoScanEnabled) {
      throw new P2PLiveError("P2P_AUTO_SCAN=false prevents automatic repricing", 409);
    }
    requireConfiguredLimits();
    assertCredentialsConfigured();
    await verifyP2PLivePermissions();
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const controlResult = await client.query(
      `SELECT live_enabled, emergency_stopped
       FROM public.p2p_live_control
       WHERE id = 1
       FOR UPDATE`,
    );
    const control = controlResult.rows[0] as {
      live_enabled: boolean;
      emergency_stopped: boolean;
    } | undefined;
    if (!control) throw new Error("P2P live control row is missing");
    if (enabled && (!control.live_enabled || control.emergency_stopped)) {
      throw new P2PLiveError("Enable LIVE mode and clear emergency STOP before automatic repricing", 409);
    }
    if (enabled) {
      const activeConfigs = await client.query(
        `SELECT COUNT(*)::integer AS count
         FROM public.p2p_ad_repricing_configs
         WHERE enabled = TRUE
           AND reference_price IS NOT NULL
           AND minimum_margin_percent IS NOT NULL
           AND pause_reason IS NULL
           AND pricing_parameters_updated_at >= NOW() - ($1::integer * INTERVAL '1 day')`,
        [config.p2pReferenceMaximumAgeDays],
      );
      if (Number(activeConfigs.rows[0]?.count ?? 0) === 0) {
        throw new P2PLiveError("Enable at least one ad with a fresh reference price and minimum margin first", 409);
      }
    }
    const updated = await client.query(
      `UPDATE public.p2p_live_control
       SET auto_repricing_enabled = $1,
           scan_interval_ms = $2,
           scan_interval_source = 'dashboard',
           updated_by = $3,
           updated_at = NOW()
       WHERE id = 1
       RETURNING live_enabled, emergency_stopped, auto_repricing_enabled,
                 scan_interval_ms, permissions_verified_at`,
      [enabled, scanIntervalMs, actor],
    );
    const row = updated.rows[0] as LiveControlRow | undefined;
    if (!row) throw new Error("P2P live control row is missing");
    await insertAuditEvent(
      client,
      requestId,
      actor,
      enabled ? "p2p_automatic_repricing_enabled" : "p2p_automatic_repricing_disabled",
      enabled ? "success" : "stopped",
      { scanIntervalMs },
    );
    await client.query("COMMIT");
    return mapControl(row, configuredLimits());
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error({
        errorName: rollbackError instanceof Error ? rollbackError.name : "UnknownError",
      }, "Failed to roll back automatic repricing setting");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getP2PAutomationMetrics(): Promise<{
  latestScan: {
    completedAt: string | null;
    durationMs: number;
    apiCallCount: number;
    averageApiLatencyMs: number;
    averageDurationMs: number;
    rateLimitWarnings: number;
  };
  updates: {
    updatedToday: number;
    failedToday: number;
    lastSuccessfulUpdateAt: string | null;
    averageUpdateDurationMs: number;
  };
}> {
  const [scanResult, updateResult] = await Promise.all([
    pool.query(
      `WITH recent AS (
         SELECT started_at, completed_at, duration_ms, api_call_count,
                average_api_latency_ms, rate_limit_warnings
         FROM public.p2p_scan_runs
         ORDER BY started_at DESC
         LIMIT 20
       )
       SELECT MAX(completed_at) AS completed_at,
              COALESCE((ARRAY_AGG(duration_ms ORDER BY started_at DESC))[1], 0) AS duration_ms,
              COALESCE((ARRAY_AGG(api_call_count ORDER BY started_at DESC))[1], 0) AS api_call_count,
              COALESCE((ARRAY_AGG(average_api_latency_ms ORDER BY started_at DESC))[1], 0) AS average_api_latency_ms,
              COALESCE(AVG(duration_ms), 0)::integer AS average_duration_ms,
              COALESCE(SUM(rate_limit_warnings), 0)::integer AS rate_limit_warnings
       FROM recent`,
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (
                WHERE action = 'p2p_live_ad_update_succeeded' AND actor = 'system:auto'
              )::integer AS updated_today,
              COUNT(*) FILTER (
                WHERE action = 'p2p_live_ad_update_failed' AND actor = 'system:auto'
              )::integer AS failed_today,
              MAX(created_at) FILTER (
                WHERE action = 'p2p_live_ad_update_succeeded' AND actor = 'system:auto'
              ) AS last_successful_update_at,
              COALESCE(AVG(NULLIF(details->>'durationMs', '')::numeric)
                FILTER (
                  WHERE action IN ('p2p_live_ad_update_succeeded', 'p2p_live_ad_update_failed')
                    AND actor = 'system:auto'
                ), 0)::integer
                AS average_update_duration_ms
       FROM public.audit_events
       WHERE created_at >= NOW() - INTERVAL '1 day'`,
    ),
  ]);
  const scan = scanResult.rows[0];
  const updates = updateResult.rows[0];
  return {
    latestScan: {
      completedAt: scan.completed_at ? new Date(scan.completed_at as Date).toISOString() : null,
      durationMs: Number(scan.duration_ms),
      apiCallCount: Number(scan.api_call_count),
      averageApiLatencyMs: Number(scan.average_api_latency_ms),
      averageDurationMs: Number(scan.average_duration_ms),
      rateLimitWarnings: Number(scan.rate_limit_warnings),
    },
    updates: {
      updatedToday: Number(updates.updated_today),
      failedToday: Number(updates.failed_today),
      lastSuccessfulUpdateAt: updates.last_successful_update_at
        ? new Date(updates.last_successful_update_at as Date).toISOString()
        : null,
      averageUpdateDurationMs: Number(updates.average_update_duration_ms),
    },
  };
}

export function validateLiveAdUpdate(
  proposal: P2PPriceProposal & { id: string },
  ad: P2PAd,
  limits: P2PLiveLimits,
  repricing: P2PAdRepricingSettings,
  now = Date.now(),
): void {
  if (!liveAdIdPattern.test(proposal.ownAdId) || ad.id !== proposal.ownAdId) {
    throw new P2PLiveError("Advertisement ID did not match the stored proposal");
  }
  if (!["BTC", "USDT"].includes(proposal.tokenId)
    || ad.tokenId !== proposal.tokenId
    || proposal.currencyId !== "NGN"
    || ad.currencyId !== proposal.currencyId) {
    throw new P2PLiveError("Advertisement asset or fiat currency did not match the stored proposal");
  }
  if ((proposal.side !== "0" && proposal.side !== "1") || ad.side !== proposal.side) {
    throw new P2PLiveError("Advertisement trading direction did not match the stored proposal");
  }
  if (!repricing.enabled
    || repricing.adId !== proposal.ownAdId
    || repricing.tokenId !== proposal.tokenId
    || repricing.currencyId !== proposal.currencyId
    || repricing.side !== proposal.side
    || repricing.pauseReason) {
    throw new P2PLiveError("Automatic repricing is disabled or paused for this advertisement", 409);
  }
  if (!repricing.referencePrice || repricing.minimumMarginPercent === null
    || !repricing.pricingParametersUpdatedAt) {
    throw new P2PLiveError("Advertisement reference price and minimum margin are required", 409);
  }
  const pricingInputsUpdatedAt = new Date(repricing.pricingParametersUpdatedAt).getTime();
  if (!Number.isFinite(pricingInputsUpdatedAt)
    || now - pricingInputsUpdatedAt > config.p2pReferenceMaximumAgeDays * 86_400_000
    || pricingInputsUpdatedAt > now + 30_000) {
    throw new P2PLiveError("Advertisement reference price or margin is stale; confirm the values again", 409, true);
  }
  if (ad.status !== 10 || ad.priceType !== "0") {
    throw new P2PLiveError("Only online fixed-price advertisements can be updated");
  }
  if (!ad.minAmount || !ad.maxAmount) {
    throw new P2PLiveError("Advertisement minimum and maximum limits are missing");
  }

  const currentPrice = ngnUnits(ad.price, "Current advertisement price");
  const proposalCurrentPrice = ngnUnits(proposal.currentPrice, "Proposal current price");
  const proposedPrice = ngnUnits(proposal.proposedPrice, "Proposed price");
  const referencePrice = ngnUnits(repricing.referencePrice, "Advertisement reference price");
  const minPrice = ngnUnits(limits.minPriceNgn, "Configured minimum price");
  const maxPrice = ngnUnits(limits.maxPriceNgn, "Configured maximum price");
  const maxChange = ngnUnits(limits.maxChangeNgn, "Configured maximum price change");
  const minAmount = ngnUnits(ad.minAmount, "Advertisement minimum limit");
  const maxAmount = ngnUnits(ad.maxAmount, "Advertisement maximum limit");

  if (currentPrice <= 0n || proposedPrice <= 0n) {
    throw new P2PLiveError("Current and proposed advertisement prices must be greater than zero");
  }
  if (minAmount <= 0n || maxAmount < minAmount) {
    throw new P2PLiveError("Advertisement minimum and maximum limits are invalid");
  }
  if (currentPrice !== proposalCurrentPrice) {
    throw new P2PLiveError("Advertisement price changed after this proposal; run a fresh scan", 409, true);
  }
  if (proposedPrice < minPrice || proposedPrice > maxPrice) {
    throw new P2PLiveError("Proposed price is outside the configured live price boundaries", 409, true);
  }
  let minimumProfitablePrice: bigint;
  try {
    minimumProfitablePrice = ngnUnits(
      calculateMinimumProfitablePrice(
        proposal.side,
        repricing.referencePrice,
        repricing.minimumMarginPercent,
      ),
      "Minimum profitable price",
    );
  } catch (error) {
    throw new P2PLiveError(error instanceof Error ? error.message : "Minimum profit margin is invalid", 409);
  }
  if (proposal.minimumProfitablePrice !== calculateMinimumProfitablePrice(
    proposal.side,
    repricing.referencePrice,
    repricing.minimumMarginPercent,
  )) {
    throw new P2PLiveError("Stored minimum profitable price does not match the current ad settings", 409);
  }
  if ((proposal.side === "1" && proposedPrice < minimumProfitablePrice)
    || (proposal.side === "0" && proposedPrice > minimumProfitablePrice)) {
    throw new P2PLiveError("Proposed price violates this advertisement's minimum profit margin", 409, true);
  }
  if (referencePrice <= 0n) {
    throw new P2PLiveError("Advertisement reference price must be greater than zero", 409);
  }
  const actualChange = proposedPrice > currentPrice
    ? proposedPrice - currentPrice
    : currentPrice - proposedPrice;
  const recordedChange = ngnUnits(proposal.priceDeltaNgn, "Proposal price change");
  if (actualChange === 0n || actualChange !== recordedChange) {
    throw new P2PLiveError("Proposal price change is invalid or no longer applicable");
  }
  if (actualChange > maxChange) {
    throw new P2PLiveError("Proposed price change exceeds the configured maximum change", 409, true);
  }
  if (actualChange < ngnUnits(repricing.minimumDifferenceNgn, "Minimum price difference")) {
    throw new P2PLiveError("Price change is below this advertisement's configured minimum difference", 409);
  }
}

export function validateProposalAge(
  createdAt: string,
  now = Date.now(),
  maximumAgeMs = proposalMaximumAgeMs,
): void {
  const proposalCreatedAt = new Date(createdAt).getTime();
  if (!Number.isFinite(proposalCreatedAt)
    || now - proposalCreatedAt > maximumAgeMs
    || proposalCreatedAt > now + 30_000) {
    throw new P2PLiveError("Price proposal is stale; run a fresh scan before applying it", 409, true);
  }
}

export function resolveAdPaymentIds(ad: P2PAd, payments: P2PPayment[]): string[] {
  if (!ad.paymentTerms?.length) {
    throw new P2PLiveError("Bybit did not return the advertisement's exact payment method IDs");
  }
  const methodsById = new Map(payments.map((payment) => [payment.id, payment]));
  const paymentTerms = [...new Map(ad.paymentTerms.map((term) => [term.id, term])).values()];
  const paymentIds = paymentTerms.map((term) => {
    const accountPayment = methodsById.get(term.id);
    if (!accountPayment || accountPayment.paymentType !== term.paymentType) {
      throw new P2PLiveError("Could not verify an advertisement payment method against the account payment list");
    }
    return term.id;
  });
  const adPaymentTypes = new Set(ad.payments);
  const termPaymentTypes = new Set(paymentTerms.map((term) => term.paymentType));
  if (adPaymentTypes.size !== termPaymentTypes.size
    || [...adPaymentTypes].some((paymentType) => !termPaymentTypes.has(paymentType))) {
    throw new P2PLiveError("Advertisement payment methods changed or could not be verified");
  }
  if (!paymentIds.length || paymentIds.length > 5) {
    throw new P2PLiveError("Advertisement must have between 1 and 5 verifiable payment methods");
  }
  return paymentIds;
}

function safeApiResponse(response: unknown): unknown {
  if (Array.isArray(response)) return response.map(safeApiResponse);
  if (typeof response === "string") {
    let safe = response;
    for (const credential of [config.bybitApiKey, config.bybitApiSecret]) {
      if (credential) safe = safe.split(credential).join("[REDACTED]");
    }
    return safe;
  }
  if (!response || typeof response !== "object") return response;
  return Object.fromEntries(Object.entries(response).map(([key, value]) => {
    if (/secret|token|key|password|signature|account|card|mobile|email|bank/i.test(key)) {
      return [key, "[REDACTED]"];
    }
    return [key, safeApiResponse(value)];
  }));
}

function safeErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : "Unknown error";
  for (const credential of [config.bybitApiKey, config.bybitApiSecret]) {
    if (credential) message = message.split(credential).join("[REDACTED]");
  }
  return message.replace(/(api[_-]?key|api[_-]?secret|password|token|signature)=?[^&\s]*/gi, "$1=[REDACTED]");
}

async function getP2PAdRepricingSettings(
  adId: string,
): Promise<P2PAdRepricingSettings | null> {
  const result = await pool.query(
    `SELECT ad_id, token_id, currency_id, side, enabled, reference_price,
            minimum_margin_percent, competitive_offset_ngn, minimum_difference_ngn,
            minimum_competitor_liquidity_ngn, min_recent_order_num,
            min_recent_execute_rate, pricing_parameters_updated_at, pause_reason
     FROM public.p2p_ad_repricing_configs
     WHERE ad_id = $1`,
    [adId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    adId: row.ad_id as string,
    tokenId: row.token_id as "BTC" | "USDT",
    currencyId: row.currency_id as "NGN",
    side: row.side === 0 ? "0" : "1",
    enabled: row.enabled as boolean,
    referencePrice: row.reference_price === null ? null : String(row.reference_price),
    minimumMarginPercent: row.minimum_margin_percent === null
      ? null
      : String(row.minimum_margin_percent),
    competitiveOffsetNgn: String(row.competitive_offset_ngn),
    minimumDifferenceNgn: String(row.minimum_difference_ngn),
    minimumCompetitorLiquidityNgn: String(row.minimum_competitor_liquidity_ngn),
    minRecentOrderNum: Number(row.min_recent_order_num),
    minRecentExecuteRate: String(row.min_recent_execute_rate),
    pricingParametersUpdatedAt: row.pricing_parameters_updated_at
      ? new Date(row.pricing_parameters_updated_at as Date).toISOString()
      : null,
    pauseReason: row.pause_reason as string | null,
  };
}

async function pauseAutomaticRepricing(
  requestId: string | undefined,
  actor: string,
  reason: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE public.p2p_live_control
       SET auto_repricing_enabled = FALSE,
           updated_by = 'system',
           updated_at = NOW()
       WHERE id = 1`,
    );
    await insertAuditEvent(client, requestId, actor, "p2p_automatic_repricing_paused", "paused", {
      reason,
      pausedAt: new Date().toISOString(),
    });
    await client.query("COMMIT");
    logger.error({ reason }, "Automatic P2P repricing paused");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error({
        errorName: rollbackError instanceof Error ? rollbackError.name : "UnknownError",
      }, "Failed to roll back automatic repricing pause");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function pauseAdvertisementRepricing(
  adId: string,
  requestId: string | undefined,
  actor: string,
  reason: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE public.p2p_ad_repricing_configs
       SET pause_reason = $2, paused_at = NOW(), updated_at = NOW()
       WHERE ad_id = $1`,
      [adId, reason],
    );
    await insertAuditEvent(client, requestId, actor, "p2p_ad_repricing_paused", "paused", {
      adId,
      reason,
      pausedAt: new Date().toISOString(),
    });
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error({
        errorName: rollbackError instanceof Error ? rollbackError.name : "UnknownError",
      }, "Failed to roll back advertisement repricing pause");
    }
    throw error;
  } finally {
    client.release();
  }
}

export function isBybitAuthenticationError(error: unknown): boolean {
  return error instanceof BybitRequestError
    && [10003, 10004, 10005, 10007].includes(error.options.retCode ?? -1);
}

function isBybitRateLimitError(error: unknown): boolean {
  return error instanceof BybitRequestError
    && (error.options.retCode === 10006 || error.options.httpStatus === 429);
}

async function recordUpdateStart(
  proposalId: string,
  proposal: StoredP2PProposal,
  actor: string,
  requestId?: string,
): Promise<PoolClient> {
  const client = await pool.connect();
  let advisoryLockAcquired = false;
  let transactionOpen = false;
  try {
    const lock = await client.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [`p2p-live-ad:${proposal.ownAdId}`],
    );
    advisoryLockAcquired = lock.rows[0]?.acquired === true;
    if (!advisoryLockAcquired) {
      throw new P2PLiveError("Another update for this advertisement is already running", 409);
    }
    await client.query("BEGIN");
    transactionOpen = true;
    const control = await client.query(
      `SELECT live_enabled, emergency_stopped, auto_repricing_enabled
       FROM public.p2p_live_control
       WHERE id = 1
       FOR SHARE`,
    );
    const controlRow = control.rows[0] as {
      live_enabled: boolean;
      emergency_stopped: boolean;
      auto_repricing_enabled: boolean;
    } | undefined;
    if (!controlRow?.live_enabled || controlRow.emergency_stopped
      || (actor === "system:auto" && !controlRow.auto_repricing_enabled)) {
      throw new P2PLiveError("Live mode is disabled or emergency STOP is active", 409);
    }

    const previous = await client.query(
      `SELECT 1 FROM public.audit_events
       WHERE action = 'p2p_live_ad_update_started'
         AND details->>'proposalId' = $1
       LIMIT 1`,
      [proposalId],
    );
    if (previous.rowCount) {
      throw new P2PLiveError("This proposal has already been submitted; run a fresh scan before another update", 409);
    }

    const recentUpdates = await client.query(
      `SELECT MAX(created_at) AS latest
       FROM public.audit_events
       WHERE action = 'p2p_live_ad_update_started'
         AND details->>'adId' = $1
         AND created_at >= NOW() - INTERVAL '1 day'`,
      [proposal.ownAdId],
    );
    const updatesToday = await client.query(
      `SELECT COUNT(*)::integer AS count
       FROM public.audit_events
       WHERE action = 'p2p_live_ad_update_started'
         AND created_at >= NOW() - INTERVAL '1 day'`,
    );
    if (Number(updatesToday.rows[0]?.count ?? 0) >= config.p2pMaximumUpdatesPerDay) {
      throw new P2PLiveError("The configured daily update limit has been reached", 429);
    }
    const latestUpdate = recentUpdates.rows[0]?.latest
      ? new Date(recentUpdates.rows[0].latest as Date).getTime()
      : null;
    if (latestUpdate !== null && Date.now() - latestUpdate < config.p2pMinimumUpdateIntervalMs) {
      throw new P2PLiveError("The minimum interval between updates for this ad has not elapsed", 429);
    }
    const oneMinuteUpdates = await client.query(
      `SELECT COUNT(*)::integer AS count
       FROM public.audit_events
       WHERE action = 'p2p_live_ad_update_started'
         AND details->>'adId' = $1
         AND created_at >= NOW() - INTERVAL '1 minute'`,
      [proposal.ownAdId],
    );
    if (Number(oneMinuteUpdates.rows[0]?.count ?? 0) >= config.p2pMaximumUpdatesPerAdPerMinute) {
      throw new P2PLiveError("The configured per-ad updates-per-minute limit has been reached", 429);
    }
    const bybitLimit = await client.query(
      `SELECT COUNT(*)::integer AS count
       FROM public.audit_events
       WHERE action = 'p2p_live_ad_update_started'
         AND details->>'adId' = $1
         AND created_at >= NOW() - INTERVAL '5 minutes'`,
      [proposal.ownAdId],
    );
    if (Number(bybitLimit.rows[0]?.count ?? 0) >= 10) {
      throw new P2PLiveError("Bybit's per-ad update limit has been reached; wait at least five minutes", 429);
    }

    await insertAuditEvent(client, requestId, actor, "p2p_live_ad_update_started", "started", {
      proposalId,
      adId: proposal.ownAdId,
      tokenId: proposal.tokenId,
      currencyId: proposal.currencyId,
      side: proposal.side,
      currentPrice: proposal.currentPrice,
      proposedPrice: proposal.proposedPrice,
      startedAt: new Date().toISOString(),
    });
    await client.query("COMMIT");
    transactionOpen = false;
    return client;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        logger.error({
          errorName: rollbackError instanceof Error ? rollbackError.name : "UnknownError",
        }, "Failed to roll back P2P live-update start record");
      }
    }
    if (advisoryLockAcquired) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`p2p-live-ad:${proposal.ownAdId}`]);
      } catch (unlockError) {
        logger.error({
          errorName: unlockError instanceof Error ? unlockError.name : "UnknownError",
        }, "Failed to release P2P ad lock after rejected update");
      }
    }
    client.release();
    throw error;
  }
}

async function recordUpdateOutcome(
  proposal: StoredP2PProposal,
  actor: string,
  requestId: string | undefined,
  result: "success" | "failed",
  details: Record<string, unknown>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await insertAuditEvent(
      client,
      requestId,
      actor,
      result === "success" ? "p2p_live_ad_update_succeeded" : "p2p_live_ad_update_failed",
      result,
      {
        proposalId: proposal.id,
        adId: proposal.ownAdId,
        tokenId: proposal.tokenId,
        currencyId: proposal.currencyId,
        side: proposal.side,
        currentPrice: proposal.currentPrice,
        proposedPrice: proposal.proposedPrice,
        completedAt: new Date().toISOString(),
        ...details,
      },
    );
  } finally {
    client.release();
  }
}

export async function applyP2PPriceProposal(
  proposalId: string,
  actor: string,
  requestId?: string,
): Promise<{ adId: string; updatedPrice: string; apiResponse: unknown }> {
  const adUpdateLock = await tryAcquireAdUpdateLock(proposalId, serverInstanceId);
  const limits = requireConfiguredLimits();
  const status = await getP2PLiveStatus();
  if (status.mode !== "live" || status.emergencyStopped) {
    throw new P2PLiveError("Enable live mode and clear emergency STOP before applying a price update", 409);
  }
  if (actor === "system:auto" && !status.automaticRepricingEnabled) {
    throw new P2PLiveError("Automatic repricing is disabled", 409);
  }

  const proposal = await getP2PProposalById(proposalId);
  if (!proposal) throw new P2PLiveError("Price proposal was not found", 404);
  const lockClient = await recordUpdateStart(proposalId, proposal, actor, requestId);

  // Distributed rate-limit: per-ad per-minute
  const perMinuteLimit = await checkDistributedRateLimit(
    `p2p:ratelimit:ad:${proposal.ownAdId}:minute`,
    config.p2pMaximumUpdatesPerAdPerMinute,
    60,
  );
  if (!perMinuteLimit.allowed) {
    throw new P2PLiveError(
      `The configured per-ad updates-per-minute limit has been reached${perMinuteLimit.reason ? `: ${perMinuteLimit.reason}` : ""}`,
      429,
    );
  }

  // Distributed rate-limit: daily total
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dailyLimit = await checkDistributedRateLimit(
    `p2p:ratelimit:daily:${today}`,
    config.p2pMaximumUpdatesPerDay,
    86_400,
  );
  if (!dailyLimit.allowed) {
    throw new P2PLiveError(
      `The configured daily update limit has been reached${dailyLimit.reason ? `: ${dailyLimit.reason}` : ""}`,
      429,
    );
  }

  let apiResponseForAudit: unknown;
  let outcomeRecorded = false;
  let updateAttempted = false;
  const startedAt = Date.now();
  try {
    validateProposalAge(proposal.createdAt);
    await verifyP2PLivePermissions();
    const ownAds = await fetchOwnAds(proposal.tokenId, proposal.side);
    if (!ownAds.some((ad) => ad.id === proposal.ownAdId)) {
      throw new P2PLiveError("Advertisement is not present in the authenticated account's own ad list", 403, true);
    }
    const currentAd = await fetchP2PAdDetails(proposal.ownAdId);
    const repricingSettings = await getP2PAdRepricingSettings(proposal.ownAdId);
    if (!repricingSettings) {
      throw new P2PLiveError("Advertisement has no saved automatic repricing configuration", 409);
    }
    validateLiveAdUpdate(proposal, currentAd, limits, repricingSettings);
    const userPayments = await fetchP2PUserPayments();
    const latestSettings = await getP2PAdRepricingSettings(proposal.ownAdId);
    const finalAd = await fetchP2PAdDetails(proposal.ownAdId);
    if (!latestSettings) {
      throw new P2PLiveError("Advertisement repricing configuration was removed", 409);
    }
    validateProposalAge(proposal.createdAt);
    validateLiveAdUpdate(proposal, finalAd, limits, latestSettings);
    const paymentIds = resolveAdPaymentIds(finalAd, userPayments);
    const currentStatus = await getP2PLiveStatus();
    if (currentStatus.mode !== "live" || currentStatus.emergencyStopped
      || (actor === "system:auto" && !currentStatus.automaticRepricingEnabled)) {
      throw new P2PLiveError("Live update cancelled because emergency STOP is active", 409);
    }
    validateProposalAge(proposal.createdAt);

    updateAttempted = true;
    const response = await updateP2PAd(
      buildAdUpdatePayload(finalAd, proposal.proposedPrice, paymentIds),
    );
    apiResponseForAudit = safeApiResponse({
      retCode: response.retCode,
      retMsg: response.retMsg,
      result: response.result,
    });
    if (response.result && typeof response.result === "object"
      && "needSecurityRisk" in response.result
      && response.result.needSecurityRisk === true) {
      throw new P2PLiveError("Bybit requires a security-risk confirmation; the bot does not complete that flow", 409);
    }
    let confirmedAd: P2PAd | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      confirmedAd = await fetchP2PAdDetails(proposal.ownAdId);
      if (ngnUnits(confirmedAd.price, "Bybit-confirmed advertisement price")
        === ngnUnits(proposal.proposedPrice, "Proposed price")) break;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    if (!confirmedAd
      || ngnUnits(confirmedAd.price, "Bybit-confirmed advertisement price")
        !== ngnUnits(proposal.proposedPrice, "Proposed price")) {
      throw new P2PLiveError(
        "Bybit returned success but the updated advertisement price could not be verified",
        503,
        true,
      );
    }
    await recordUpdateOutcome(proposal, actor, requestId, "success", {
      apiResponse: apiResponseForAudit,
      verifiedPrice: confirmedAd.price,
      durationMs: Date.now() - startedAt,
    });
    outcomeRecorded = true;
    logger.warn({
      actor,
      adId: proposal.ownAdId,
      proposalId,
      previousPrice: proposal.currentPrice,
      updatedPrice: proposal.proposedPrice,
    }, "Live P2P advertisement price updated");
    return {
      adId: proposal.ownAdId,
      updatedPrice: confirmedAd.price,
      apiResponse: apiResponseForAudit,
    };
  } catch (error) {
    if (updateAttempted) {
      try {
        const currentAd = await fetchP2PAdDetails(proposal.ownAdId);
        const actualPrice = ngnUnits(currentAd.price, "Reconciled advertisement price");
        if (actualPrice === ngnUnits(proposal.proposedPrice, "Proposed price")) {
          await recordUpdateOutcome(proposal, actor, requestId, "success", {
            apiResponse: apiResponseForAudit,
            verifiedPrice: currentAd.price,
            reconciledAfterError: true,
            durationMs: Date.now() - startedAt,
          });
          outcomeRecorded = true;
          logger.warn({
            actor,
            adId: proposal.ownAdId,
            proposalId,
            updatedPrice: currentAd.price,
          }, "Bybit confirmed the P2P price update during reconciliation");
          return {
            adId: proposal.ownAdId,
            updatedPrice: currentAd.price,
            apiResponse: apiResponseForAudit,
          };
        }
        if (actualPrice !== ngnUnits(proposal.currentPrice, "Original advertisement price")) {
          await pauseAdvertisementRepricing(
            proposal.ownAdId,
            requestId,
            actor,
            "Advertisement price changed unexpectedly during update reconciliation",
          );
        }
      } catch (reconciliationError) {
        logger.error({
          proposalId,
          adId: proposal.ownAdId,
          errorName: reconciliationError instanceof Error ? reconciliationError.name : "UnknownError",
        }, "Could not reconcile Bybit advertisement state after update attempt");
        if (!(error instanceof P2PLiveError && error.pauseAdvertisement)) {
          error = new P2PLiveError(
            "Update outcome could not be confirmed; automatic repricing is paused until the ad is checked",
            503,
            true,
          );
        }
      }
    }
    if (actor === "system:auto" && isBybitAuthenticationError(error)) {
      await pauseAutomaticRepricing(
        requestId,
        actor,
        "Bybit API authentication or permission check failed",
      );
    } else if (actor === "system:auto" && isBybitRateLimitError(error)) {
      await pauseAutomaticRepricing(
        requestId,
        actor,
        "Bybit rate limiting persisted after bounded retries",
      );
    } else if (actor === "system:auto"
      && error instanceof P2PLiveError
      && error.pauseAdvertisement) {
      await pauseAdvertisementRepricing(
        proposal.ownAdId,
        requestId,
        actor,
        safeErrorMessage(error),
      );
    }
    if (!outcomeRecorded) {
      try {
        await recordUpdateOutcome(proposal, actor, requestId, "failed", {
          ...(apiResponseForAudit ? { apiResponse: apiResponseForAudit } : {}),
          error: safeErrorMessage(error),
          durationMs: Date.now() - startedAt,
        });
        outcomeRecorded = true;
      } catch (auditError) {
        logger.error({
          proposalId,
          adId: proposal.ownAdId,
          errorName: auditError instanceof Error ? auditError.name : "UnknownError",
        }, "Could not persist P2P live-update outcome; inspect Bybit ad state before retrying");
      }
    }
    logger.error({
      actor,
      adId: proposal.ownAdId,
      proposalId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    }, "Live P2P advertisement update failed");
    throw error;
  } finally {
    await releaseAdUpdateLock(adUpdateLock);
    try {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [`p2p-live-ad:${proposal.ownAdId}`]);
    } catch (error) {
      logger.error({
        proposalId,
        adId: proposal.ownAdId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }, "Could not release P2P advertisement update lock");
    } finally {
      lockClient.release();
    }
  }
}
