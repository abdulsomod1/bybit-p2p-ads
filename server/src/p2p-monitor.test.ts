import { beforeEach, describe, expect, it, vi } from "vitest";

const { clientQueryMock, poolQueryMock, scanP2PMarketMock } = vi.hoisted(() => ({
  clientQueryMock: vi.fn(),
  poolQueryMock: vi.fn(),
  scanP2PMarketMock: vi.fn(),
}));

vi.mock("./db.js", () => ({
  pool: {
    query: poolQueryMock,
    connect: vi.fn(async () => ({
      query: clientQueryMock,
      release: vi.fn(),
    })),
  },
}));

vi.mock("./config.js", () => ({
  config: {
    p2pAutoScanEnabled: true,
    p2pScanIntervalMs: 5_000,
    p2pLargeChangeThresholdNgn: 600,
    p2pReferenceMaximumAgeDays: 30,
    bybitApiKey: "test-key",
    bybitApiSecret: "test-secret",
  },
}));

vi.mock("./p2p.js", () => ({
  ngnUnits: (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole) * 10n ** 10n + BigInt(fraction.padEnd(10, "0"));
  },
  scanP2PMarket: scanP2PMarketMock,
}));

import {
  clearAutomaticRepricingPause,
  configureAutomaticProposalHandler,
  scanAndStoreP2PProposals,
  startP2PScanner,
} from "./p2p-monitor.js";

const proposal = {
  tokenId: "BTC" as const,
  currencyId: "NGN" as const,
  side: "1" as const,
  ownAdId: "123",
  currentPrice: "100",
  competitorAdId: "456",
  competitorNickname: "verified merchant",
  competitorAuthTags: ["VA"],
  proposedPrice: "99",
  priceDeltaNgn: "1",
  largeChange: false,
  matchingPaymentTypes: ["14"],
  estimatedProfitPerToken: "10",
  projectedMarginPercent: "10",
  minimumProfitablePrice: "95",
  minimumDifferenceNgn: "1",
};

function configureDatabase(emergencyStopped: boolean): void {
  poolQueryMock.mockImplementation(async (query: string) => {
    if (query.includes("FROM public.p2p_ad_repricing_configs")) {
      return {
        rows: [{
          ad_id: proposal.ownAdId,
          token_id: proposal.tokenId,
          currency_id: proposal.currencyId,
          side: 1,
          enabled: true,
          reference_price: "90",
          minimum_margin_percent: "5",
          competitive_offset_ngn: "1",
          minimum_difference_ngn: "1",
          minimum_competitor_liquidity_ngn: "0",
          min_recent_order_num: 0,
          min_recent_execute_rate: "0",
          pricing_parameters_updated_at: new Date(),
          pause_reason: null,
        }],
      };
    }
    if (query.includes("FROM public.p2p_live_control")) {
      return {
        rows: [{
          live_enabled: true,
          emergency_stopped: emergencyStopped,
          auto_repricing_enabled: true,
        }],
      };
    }
    return { rows: [], rowCount: 1 };
  });
  clientQueryMock.mockImplementation(async (query: string) => {
    if (query.includes("INSERT INTO p2p_price_proposals")) {
      return {
        rows: [{
          id: "proposal-id",
          created_at: new Date(),
          execution_status: "dry_run",
          execution_message: "",
        }],
      };
    }
    return { rows: [], rowCount: 1 };
  });
  scanP2PMarketMock.mockResolvedValue({
    proposals: [proposal],
    metrics: {
      requestCount: 1,
      totalLatencyMs: 10,
      averageLatencyMs: 10,
      rateLimitWarnings: 0,
    },
  });
}

describe("automatic P2P proposal execution", () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    clientQueryMock.mockReset();
    scanP2PMarketMock.mockReset();
  });

  it("applies eligible proposals through the automatic handler without manual approval", async () => {
    configureDatabase(false);
    const automaticHandler = vi.fn(async () => ({
      status: "updated" as const,
      message: "Bybit accepted and verified the new advertisement price.",
    }));
    configureAutomaticProposalHandler(automaticHandler);

    const [result] = await scanAndStoreP2PProposals();

    expect(automaticHandler).toHaveBeenCalledWith("proposal-id");
    expect(result.executionStatus).toBe("updated");
  });

  it("does not dispatch updates while emergency STOP is active", async () => {
    configureDatabase(true);
    const automaticHandler = vi.fn(async () => ({
      status: "updated" as const,
      message: "Bybit accepted and verified the new advertisement price.",
    }));
    configureAutomaticProposalHandler(automaticHandler);

    const [result] = await scanAndStoreP2PProposals();

    expect(automaticHandler).not.toHaveBeenCalled();
    expect(result.executionStatus).toBe("dry_run");
  });

  it("keeps market scans responsive while an advertisement update is pending", async () => {
    configureDatabase(false);
    let finishUpdate: ((outcome: {
      status: "updated";
      message: string;
    }) => void) | undefined;
    const automaticHandler = vi.fn(() => new Promise<{
      status: "updated";
      message: string;
    }>((resolve) => {
      finishUpdate = resolve;
    }));
    configureAutomaticProposalHandler(automaticHandler);

    await expect(scanAndStoreP2PProposals(false)).resolves.toHaveLength(1);
    expect(automaticHandler).toHaveBeenCalledTimes(1);
    finishUpdate?.({
      status: "updated",
      message: "Bybit accepted and verified the new advertisement price.",
    });
  });

  it("does not submit a second automatic update for an ad already in flight", async () => {
    configureDatabase(false);
    let finishUpdate: ((outcome: {
      status: "updated";
      message: string;
    }) => void) | undefined;
    const automaticHandler = vi.fn(() => new Promise<{
      status: "updated";
      message: string;
    }>((resolve) => {
      finishUpdate = resolve;
    }));
    configureAutomaticProposalHandler(automaticHandler);

    await scanAndStoreP2PProposals(false);
    expect(automaticHandler).toHaveBeenCalledTimes(1);

    const [nextScanProposal] = await scanAndStoreP2PProposals(false);
    expect(automaticHandler).toHaveBeenCalledTimes(1);
    expect(nextScanProposal.executionStatus).toBe("skipped");
    finishUpdate?.({
      status: "updated",
      message: "Bybit accepted and verified the new advertisement price.",
    });
  });

  it("schedules another scan after a temporary scan failure", async () => {
    vi.useFakeTimers();
    let configurationReads = 0;
    poolQueryMock.mockImplementation(async (query: string) => {
      if (query.includes("FROM public.p2p_ad_repricing_configs")) {
        configurationReads += 1;
        if (configurationReads === 1) throw new Error("temporary database error");
        return { rows: [] };
      }
      if (query.includes("SELECT scan_interval_ms")) {
        return { rows: [{ scan_interval_ms: 5_000 }] };
      }
      if (query.includes("FROM public.p2p_live_control")) {
        return {
          rows: [{ live_enabled: false, emergency_stopped: false, auto_repricing_enabled: false }],
        };
      }
      return { rows: [], rowCount: 1 };
    });
    clientQueryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    scanP2PMarketMock.mockResolvedValue({
      proposals: [],
      metrics: { requestCount: 0, totalLatencyMs: 0, averageLatencyMs: 0, rateLimitWarnings: 0 },
    });

    const stop = startP2PScanner();
    try {
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
      expect(configurationReads).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000);
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
      expect(configurationReads).toBe(2);
    } finally {
      stop();
      clearAutomaticRepricingPause();
      vi.useRealTimers();
    }
  });
});
