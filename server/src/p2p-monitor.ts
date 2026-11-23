import crypto from "node:crypto";
import { logger } from "./logger.js";
import { pool } from "./db.js";
import { config } from "./config.js";
import {
  ngnUnits,
  scanP2PMarket,
  type P2PAdRepricingConfig,
  type P2PPriceProposal,
} from "./p2p.js";

export type StoredP2PProposal = P2PPriceProposal & {
  id: string;
  scanId: string;
  createdAt: string;
  executionStatus: "dry_run" | "updated" | "skipped" | "failed" | "paused";
  executionMessage: string;
};

type P2PProposalRow = {
  id: string;
  scan_id: string;
  token_id: "BTC" | "USDT";
  currency_id: "NGN";
  side: number;
  own_ad_id: string;
  current_price: string;
  competitor_ad_id: string;
  competitor_nickname: string;
  competitor_auth_tags: string[];
  proposed_price: string;
  price_delta_ngn: string;
  large_change: boolean;
  matching_payment_types: string[];
  estimated_profit_per_token: string;
  projected_margin_percent: string;
  minimum_profitable_price: string;
  minimum_difference_ngn: string;
  execution_status: StoredP2PProposal["executionStatus"];
  execution_message: string;
  created_at: Date | string;
};

type AutomaticOutcome = {
  status: Exclude<StoredP2PProposal["executionStatus"], "dry_run">;
  message: string;
};

let automaticProposalHandler: ((proposalId: string) => Promise<AutomaticOutcome>) | undefined;
let activeScan: Promise<StoredP2PProposal[]> | undefined;
let automaticPauseReason: string | null = null;
const automaticUpdateConcurrency = 2;
const automaticAdsInFlight = new Set<string>();

export function configureAutomaticProposalHandler(
  handler: (proposalId: string) => Promise<AutomaticOutcome>,
): void {
  automaticProposalHandler = handler;
}

export function clearAutomaticRepricingPause(): void {
  automaticPauseReason = null;
}

export async function pauseAutomaticRepricingForRuntimeFailure(reason: string): Promise<void> {
  automaticPauseReason = reason;
  try {
    await pool.query(
      `UPDATE public.p2p_live_control
       SET auto_repricing_enabled = FALSE, updated_by = 'system', updated_at = NOW()
       WHERE id = 1`,
    );
    await pool.query(
      `INSERT INTO public.audit_events (actor, action, result, details)
       VALUES ('system', 'p2p_automatic_repricing_paused', 'paused', $1::jsonb)`,
      [JSON.stringify({ reason, pausedAt: new Date().toISOString() })],
    );
  } catch (error) {
    logger.error({
      errorName: error instanceof Error ? error.name : "UnknownError",
    }, "Could not persist automatic repricing pause after runtime failure");
  }
}

async function persistProposals(
  scanId: string,
  proposals: P2PPriceProposal[],
  startedAt: Date,
  durationMs: number,
  apiCallCount: number,
  averageApiLatencyMs: number,
  rateLimitWarnings: number,
): Promise<StoredP2PProposal[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO p2p_scan_runs (
        id, started_at, completed_at, proposal_count, large_change_count,
        duration_ms, api_call_count, average_api_latency_ms
        , rate_limit_warnings
      ) VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8)`,
      [
        scanId,
        startedAt,
        proposals.length,
        proposals.filter((proposal) => proposal.largeChange).length,
        durationMs,
        apiCallCount,
        averageApiLatencyMs,
        rateLimitWarnings,
      ],
    );
    const stored: StoredP2PProposal[] = [];
    for (const proposal of proposals) {
      const result = await client.query(
        `INSERT INTO p2p_price_proposals (
          scan_id, token_id, currency_id, side, own_ad_id, current_price,
          competitor_ad_id, competitor_nickname, competitor_auth_tags,
          proposed_price, price_delta_ngn, large_change, matching_payment_types,
          estimated_profit_per_usdt, projected_margin_percent, minimum_profitable_price,
          minimum_difference_ngn, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
        )
        RETURNING id, created_at, execution_status, execution_message`,
        [
          scanId,
          proposal.tokenId,
          proposal.currencyId,
          proposal.side,
          proposal.ownAdId,
          proposal.currentPrice,
          proposal.competitorAdId,
          proposal.competitorNickname,
          proposal.competitorAuthTags,
          proposal.proposedPrice,
          proposal.priceDeltaNgn,
          proposal.largeChange,
          proposal.matchingPaymentTypes,
          proposal.estimatedProfitPerToken,
          proposal.projectedMarginPercent,
          proposal.minimumProfitablePrice,
          proposal.minimumDifferenceNgn,
          startedAt,
        ],
      );
      stored.push({
        ...proposal,
        id: result.rows[0].id,
        scanId,
        createdAt: new Date(result.rows[0].created_at).toISOString(),
        executionStatus: result.rows[0].execution_status,
        executionMessage: result.rows[0].execution_message,
      });
    }
    await client.query("COMMIT");
    return stored;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function runAutomaticProposalUpdates(
  scanId: string,
  stored: StoredP2PProposal[],
  repricingConfigs: ReadonlyMap<string, P2PAdRepricingConfig>,
): Promise<void> {
  const proposalHandler = automaticProposalHandler;
  const control = await pool.query(
    `SELECT live_enabled, emergency_stopped, auto_repricing_enabled
     FROM public.p2p_live_control
     WHERE id = 1`,
  );
  const controlRow = control.rows[0] as {
    live_enabled: boolean;
    emergency_stopped: boolean;
    auto_repricing_enabled: boolean;
  } | undefined;
  if (!controlRow?.live_enabled
    || controlRow.emergency_stopped
    || !controlRow.auto_repricing_enabled
    || automaticPauseReason
    || !proposalHandler) return;

  let nextProposalIndex = 0;
  let stopDispatch = false;
  let updatedCount = 0;
  let failedCount = 0;

  const updateProposalStatus = async (
    proposal: StoredP2PProposal,
    status: StoredP2PProposal["executionStatus"],
    message: string,
  ) => {
    proposal.executionStatus = status;
    proposal.executionMessage = message;
    await pool.query(
      `UPDATE public.p2p_price_proposals
       SET execution_status = $2, execution_message = $3
       WHERE id = $1`,
      [proposal.id, status, message],
    );
  };

  const worker = async () => {
    while (!stopDispatch) {
      const proposal = stored[nextProposalIndex++];
      if (!proposal) return;
      const repricingConfig = repricingConfigs.get(proposal.ownAdId);
      if (!repricingConfig?.enabled) continue;
      if (repricingConfig.pauseReason) {
        await updateProposalStatus(proposal, "paused", repricingConfig.pauseReason);
        continue;
      }
      if (ngnUnits(proposal.priceDeltaNgn, "Proposed price difference")
        < ngnUnits(repricingConfig.minimumDifferenceNgn, "Configured minimum price difference")) {
        await updateProposalStatus(proposal, "skipped", "Difference is below this ad's configured minimum.");
        continue;
      }
      if (automaticAdsInFlight.has(proposal.ownAdId)) {
        await updateProposalStatus(
          proposal,
          "skipped",
          "Another update for this advertisement is still running; the next scan will refresh its price.",
        );
        continue;
      }

      automaticAdsInFlight.add(proposal.ownAdId);
      try {
        const outcome = await proposalHandler(proposal.id);
        await updateProposalStatus(proposal, outcome.status, outcome.message);
        if (outcome.status === "updated") updatedCount += 1;
        if (outcome.status === "failed") failedCount += 1;
        if (outcome.status === "paused") stopDispatch = true;
      } catch (error) {
        failedCount += 1;
        logger.error({
          proposalId: proposal.id,
          adId: proposal.ownAdId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        }, "Automatic P2P repricing failed");
        await updateProposalStatus(
          proposal,
          "failed",
          "Automatic update failed; inspect the audit trail and Bybit ad.",
        );
      } finally {
        automaticAdsInFlight.delete(proposal.ownAdId);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(automaticUpdateConcurrency, stored.length) }, () => worker()),
  );
  await pool.query(
    `UPDATE public.p2p_scan_runs
     SET updated_count = $2, failed_update_count = $3
     WHERE id = $1`,
    [scanId, updatedCount, failedCount],
  );
}

export function scanAndStoreP2PProposals(
  waitForAutomaticUpdates = true,
): Promise<StoredP2PProposal[]> {
  if (activeScan) return activeScan;
  const scanId = crypto.randomUUID();
  const startedAt = new Date();
  activeScan = pool.query(
    `SELECT ad_id, token_id, currency_id, side, enabled, reference_price,
            minimum_margin_percent, competitive_offset_ngn, minimum_difference_ngn,
            minimum_competitor_liquidity_ngn, min_recent_order_num,
            min_recent_execute_rate, pricing_parameters_updated_at, pause_reason
     FROM public.p2p_ad_repricing_configs`,
  ).then(async (configResult) => {
    const now = Date.now();
    for (const row of configResult.rows) {
      if (!row.enabled) continue;
      const inputsUpdatedAt = row.pricing_parameters_updated_at
        ? new Date(row.pricing_parameters_updated_at as Date).getTime()
        : Number.NaN;
      const stale = !row.reference_price
        || !row.minimum_margin_percent
        || !Number.isFinite(inputsUpdatedAt)
        || now - inputsUpdatedAt > config.p2pReferenceMaximumAgeDays * 86_400_000
        || inputsUpdatedAt > now + 30_000;
      if (stale && !row.pause_reason) {
        await pool.query(
          `UPDATE public.p2p_ad_repricing_configs
           SET pause_reason = 'Reference price or minimum margin is missing, invalid, or stale',
               paused_at = NOW(),
               updated_at = NOW()
           WHERE ad_id = $1 AND enabled = TRUE AND pause_reason IS NULL`,
          [row.ad_id],
        );
        row.pause_reason = "Reference price or minimum margin is missing, invalid, or stale";
      }
    }
    const repricingConfigs = new Map<string, P2PAdRepricingConfig>(
      configResult.rows.map((row) => [row.ad_id as string, {
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
        minRecentOrderNum: row.min_recent_order_num as number,
        minRecentExecuteRate: String(row.min_recent_execute_rate),
        referenceUpdatedAt: row.pricing_parameters_updated_at
          ? new Date(row.pricing_parameters_updated_at as Date).toISOString()
          : null,
        pauseReason: row.pause_reason as string | null,
      }]),
    );
    const scanResult = await scanP2PMarket(
        config.p2pLargeChangeThresholdNgn,
        repricingConfigs,
        config.p2pReferenceMaximumAgeDays,
      );
    return {
        proposals: scanResult.proposals,
        metrics: scanResult.metrics,
      repricingConfigs,
    };
  })
    .then(async ({ proposals, metrics, repricingConfigs }) => {
      const durationMs = Date.now() - startedAt.getTime();
      const stored = await persistProposals(
        scanId,
        proposals,
        startedAt,
        durationMs,
        metrics.requestCount,
        metrics.averageLatencyMs,
        metrics.rateLimitWarnings,
      );
      for (const proposal of stored) {
        if (proposal.largeChange) {
          logger.warn({
            scanId,
            tokenId: proposal.tokenId,
            side: proposal.side,
            ownAdId: proposal.ownAdId,
            currentPrice: proposal.currentPrice,
            proposedPrice: proposal.proposedPrice,
            priceDeltaNgn: proposal.priceDeltaNgn,
          }, "Large P2P price change calculated");
        }
      }
      const automaticRun = runAutomaticProposalUpdates(scanId, stored, repricingConfigs);
      if (waitForAutomaticUpdates) {
        await automaticRun;
      } else {
        void automaticRun.catch(async (error: unknown) => {
          logger.error({
            scanId,
            errorName: error instanceof Error ? error.name : "UnknownError",
          }, "Background automatic P2P repricing failed");
          await pauseAutomaticRepricingForRuntimeFailure(
            "Automatic update processing or database persistence failed; re-enable after checking system health",
          );
        });
      }
      return stored;
    })
    .finally(() => {
      activeScan = undefined;
    });
  return activeScan;
}

export function getRecentP2PProposals(): Promise<StoredP2PProposal[]> {
  return pool.query(
    `SELECT id, scan_id, token_id, currency_id, side, own_ad_id,
            current_price, competitor_ad_id, competitor_nickname,
            competitor_auth_tags, proposed_price, price_delta_ngn,
            large_change, matching_payment_types,
            estimated_profit_per_usdt AS estimated_profit_per_token,
            projected_margin_percent, minimum_profitable_price, minimum_difference_ngn,
            execution_status, execution_message, created_at
     FROM p2p_price_proposals
     WHERE scan_id = (
       SELECT id FROM p2p_scan_runs
       ORDER BY started_at DESC
       LIMIT 1
     )
     ORDER BY created_at DESC
     LIMIT 100`,
  ).then((result) => result.rows.map((row) => mapStoredProposal(row as P2PProposalRow)));
}

function mapStoredProposal(row: P2PProposalRow): StoredP2PProposal {
  return {
    id: row.id,
    scanId: row.scan_id,
    tokenId: row.token_id,
    currencyId: row.currency_id,
    side: row.side === 0 ? "0" : "1",
    ownAdId: row.own_ad_id,
    currentPrice: row.current_price,
    competitorAdId: row.competitor_ad_id,
    competitorNickname: row.competitor_nickname,
    competitorAuthTags: row.competitor_auth_tags,
    proposedPrice: row.proposed_price,
    priceDeltaNgn: row.price_delta_ngn,
    largeChange: row.large_change,
    matchingPaymentTypes: row.matching_payment_types,
    estimatedProfitPerToken: row.estimated_profit_per_token,
    projectedMarginPercent: row.projected_margin_percent,
    minimumProfitablePrice: row.minimum_profitable_price,
    minimumDifferenceNgn: row.minimum_difference_ngn,
    createdAt: new Date(row.created_at).toISOString(),
    executionStatus: row.execution_status,
    executionMessage: row.execution_message,
  };
}

export async function getP2PProposalById(id: string): Promise<StoredP2PProposal | null> {
  const result = await pool.query(
    `SELECT id, scan_id, token_id, currency_id, side, own_ad_id,
            current_price, competitor_ad_id, competitor_nickname,
            competitor_auth_tags, proposed_price, price_delta_ngn,
            large_change, matching_payment_types,
            estimated_profit_per_usdt AS estimated_profit_per_token,
            projected_margin_percent, minimum_profitable_price, minimum_difference_ngn,
            execution_status, execution_message, created_at
     FROM p2p_price_proposals
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapStoredProposal(result.rows[0] as P2PProposalRow) : null;
}

export function startP2PScanner(): () => void {
  if (!config.p2pAutoScanEnabled || !config.bybitApiKey || !config.bybitApiSecret) {
    logger.info({ enabled: config.p2pAutoScanEnabled }, "P2P dry-run scanner is not started; API credentials are required");
    return () => undefined;
  }

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const run = async () => {
    const scanStartedAt = Date.now();
    try {
      await scanAndStoreP2PProposals(false);
    } catch (error) {
      logger.error({ err: error }, "P2P dry-run scan failed");
      await pauseAutomaticRepricingForRuntimeFailure(
        "Market scan or database persistence failed; re-enable automatic repricing after checking system health",
      );
    } finally {
      if (!stopped) {
        void pool.query("SELECT scan_interval_ms FROM public.p2p_live_control WHERE id = 1")
          .then((result) => {
            if (!stopped) {
              const intervalMs = Number(result.rows[0]?.scan_interval_ms ?? config.p2pScanIntervalMs);
              const nextScanDelayMs = Math.max(0, intervalMs - (Date.now() - scanStartedAt));
              timer = setTimeout(() => void run(), nextScanDelayMs);
            }
          })
          .catch((error: unknown) => {
            logger.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "Could not read P2P scan interval");
            if (!stopped) {
              const nextScanDelayMs = Math.max(
                0,
                config.p2pScanIntervalMs - (Date.now() - scanStartedAt),
              );
              timer = setTimeout(() => void run(), nextScanDelayMs);
            }
          });
      }
    }
  };
  void run();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
