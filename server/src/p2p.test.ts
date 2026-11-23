import { describe, expect, it } from "vitest";
import { BybitRequestError } from "./bybit.js";
import {
  buildAdUpdatePayload,
  buildP2PPriceProposals,
  calculateMinimumProfitablePrice,
  validateP2PLiveApiKeyPermissions,
  type P2PAd,
  type P2PAdRepricingConfig,
  type P2PPayment,
} from "./p2p.js";
import {
  resolveAdPaymentIds,
  isBybitAuthenticationError,
  validateLiveAdUpdate,
  validateProposalAge,
  type P2PLiveLimits,
} from "./p2p-live.js";

function makeAd(overrides: Partial<P2PAd> & Pick<P2PAd, "id">): P2PAd {
  const { id, ...rest } = overrides;
  return {
    id,
    userId: "merchant-1",
    nickName: "verified seller",
    tokenId: "BTC",
    currencyId: "NGN",
    side: "0",
    price: "600",
    payments: ["14"],
    authTag: ["VA"],
    status: 10,
    isOnline: true,
    recentOrderNum: "20",
    recentExecuteRate: "95",
    lastQuantity: "100",
    priceType: "0",
    premium: "",
    quantity: "0.5",
    minAmount: "5000",
    maxAmount: "100000",
    remark: "",
    tradingPreferenceSet: { isKyc: "1" },
    paymentPeriod: "15",
    ...rest,
  };
}

const userPayments: P2PPayment[] = [
  { id: "my-bank-method-1", paymentType: "14" },
  { id: "my-bank-method-2", paymentType: "15" },
];

const liveLimits: P2PLiveLimits = {
  minPriceNgn: "500",
  maxPriceNgn: "3000",
  maxChangeNgn: "600",
};

function makeRepricingConfig(
  adId: string,
  overrides: Partial<P2PAdRepricingConfig> = {},
): P2PAdRepricingConfig {
  return {
    adId,
    tokenId: "BTC",
    currencyId: "NGN",
    side: "1",
    enabled: true,
    referencePrice: "2200",
    minimumMarginPercent: "5",
    competitiveOffsetNgn: "1",
    minimumDifferenceNgn: "1",
    minimumCompetitorLiquidityNgn: "0",
    minRecentOrderNum: 10,
    minRecentExecuteRate: "80",
    referenceUpdatedAt: new Date().toISOString(),
    pauseReason: null,
    ...overrides,
  };
}

function makeLiveProposal(overrides: Partial<{
  ownAdId: string;
  tokenId: "BTC" | "USDT";
  currencyId: "NGN";
  side: "0" | "1";
  currentPrice: string;
  proposedPrice: string;
  priceDeltaNgn: string;
}> = {}) {
  return {
    id: "f22bb0d0-41fb-4b6a-92e4-473e631bab46",
    tokenId: "BTC" as const,
    currencyId: "NGN" as const,
    side: "0" as const,
    ownAdId: "1234567890123456789",
    currentPrice: "600",
    competitorAdId: "9876543210987654321",
    competitorNickname: "verified seller",
    competitorAuthTags: ["VA"],
    proposedPrice: "700",
    priceDeltaNgn: "100.00",
    estimatedProfitPerToken: "50.00",
    projectedMarginPercent: "6.6667",
    minimumProfitablePrice: "712.50",
    minimumDifferenceNgn: "1",
    largeChange: false,
    matchingPaymentTypes: ["14"],
    ...overrides,
  };
}

describe("P2P dry-run price proposals", () => {
  it("ranks eligible sellers and flags a meaningful repricing", () => {
    const ownAd = makeAd({ id: "own-ad", userId: "me", side: "1", price: "2600" });
    const ads = [
      makeAd({ id: "general-ad", authTag: ["GA"], price: "2400" }),
      makeAd({ id: "blocked-ad", authTag: ["VA", "BA"], price: "2300" }),
      makeAd({ id: "wrong-payment", payments: ["99"], price: "2200" }),
      makeAd({ id: "verified-ad", side: "1", price: "2500" }),
      makeAd({ id: "better-verified-ad", side: "1", price: "2400" }),
    ];
    const markets = new Map([["BTC:NGN:1", ads]]);

    const [proposal] = buildP2PPriceProposals(
      [ownAd],
      markets,
      new Map([["own-ad", makeRepricingConfig("own-ad")]]),
      50,
      30,
    );

    expect(proposal).toMatchObject({
      ownAdId: "own-ad",
      competitorAdId: "better-verified-ad",
      currentPrice: "2600",
      proposedPrice: "2399.00",
      priceDeltaNgn: "201.00",
      minimumProfitablePrice: "2310.00",
      largeChange: true,
    });
  });

  it("selects the highest eligible buyer and ignores the account's own ads", () => {
    const ownAd = makeAd({ id: "own-ad", userId: "me", side: "0", price: "700" });
    const ownMerchantAd = makeAd({ id: "my-other-ad", userId: "me", side: "0", price: "3000" });
    const verifiedAd = makeAd({ id: "verified-ad", side: "0", price: "1200" });
    const markets = new Map([["BTC:NGN:0", [ownMerchantAd, verifiedAd]]]);

    const [proposal] = buildP2PPriceProposals(
      [ownAd],
      markets,
      new Map([["own-ad", makeRepricingConfig("own-ad", {
        side: "0",
        referencePrice: "1500",
        minimumMarginPercent: "5",
      })]]),
      500,
      30,
    );

    expect(proposal?.competitorAdId).toBe("verified-ad");
    expect(proposal?.proposedPrice).toBe("1201.00");
    expect(proposal?.minimumProfitablePrice).toBe("1425.00");
  });

  it("does not propose price changes for variable-price ads", () => {
    const ownAd = makeAd({ id: "own-ad", side: "1", priceType: "1" });
    const competitor = makeAd({ id: "verified-ad", side: "1", price: "700" });
    const markets = new Map([["BTC:NGN:1", [competitor]]]);

    expect(buildP2PPriceProposals(
      [ownAd],
      markets,
      new Map([["own-ad", makeRepricingConfig("own-ad")]]),
      600,
      30,
    )).toEqual([]);
  });

  it("rejects competitor ads with incompatible liquidity or insufficient completion stats", () => {
    const ownAd = makeAd({ id: "own-ad", userId: "me", side: "1", minAmount: "50000", maxAmount: "100000" });
    const lowLiquidity = makeAd({
      id: "low-liquidity",
      side: "1",
      price: "2300",
      lastQuantity: "1",
      maxAmount: "10000",
    });
    const lowCompletion = makeAd({
      id: "low-completion",
      side: "1",
      price: "2400",
      recentExecuteRate: "50",
    });
    const eligible = makeAd({ id: "eligible", side: "1", price: "2500" });
    const proposals = buildP2PPriceProposals(
      [ownAd],
      new Map([["BTC:NGN:1", [lowLiquidity, lowCompletion, eligible]]]),
      new Map([["own-ad", makeRepricingConfig("own-ad")]]),
      600,
      30,
    );
    expect(proposals[0]?.competitorAdId).toBe("eligible");
  });

  it("calculates sell floors and buy ceilings from each ad's reference and margin", () => {
    expect(calculateMinimumProfitablePrice("1", "1000", "2")).toBe("1020.00");
    expect(calculateMinimumProfitablePrice("0", "1000", "2")).toBe("980.00");
  });

  it("does not produce targets that violate the ad's configured profit margin", () => {
    const sellAd = makeAd({ id: "sell-ad", userId: "me", side: "1", price: "2500" });
    const buyAd = makeAd({ id: "buy-ad", userId: "me", side: "0", price: "1300" });
    const marketAds = new Map([
      ["BTC:NGN:1", [makeAd({ id: "cheap-seller", side: "1", price: "2300" })]],
      ["BTC:NGN:0", [makeAd({ id: "expensive-buyer", side: "0", price: "1450" })]],
    ]);
    const configs = new Map([
      ["sell-ad", makeRepricingConfig("sell-ad", { side: "1", referencePrice: "2200" })],
      ["buy-ad", makeRepricingConfig("buy-ad", {
        side: "0",
        referencePrice: "1500",
        minimumMarginPercent: "5",
      })],
    ]);

    expect(buildP2PPriceProposals([sellAd, buyAd], marketAds, configs, 600, 30)).toEqual([]);
  });

  it("builds an update request preserving ad settings while changing only the price", () => {
    const ownAd = makeAd({
      id: "own-ad",
      price: "600",
      tradingPreferenceSet: { isKyc: 1, completeRateDay30: "95" },
    });
    const payload = buildAdUpdatePayload(ownAd, "2500", ["my-bank-method-1"]);

    expect(payload).toEqual({
      id: "own-ad",
      priceType: "0",
      premium: "",
      price: "2500",
      minAmount: "5000",
      maxAmount: "100000",
      remark: "",
      tradingPreferenceSet: { isKyc: "1", completeRateDay30: "95" },
      paymentIds: ["my-bank-method-1"],
      actionType: "MODIFY",
      quantity: "0.5",
      paymentPeriod: "15",
    });
  });

  it("accepts a fresh, matching online fixed-price ad update within configured boundaries", () => {
    const ad = makeAd({ id: "1234567890123456789", price: "600", minAmount: "5000", maxAmount: "100000" });

    const settings = {
      adId: "1234567890123456789",
      tokenId: "BTC" as const,
      currencyId: "NGN" as const,
      side: "0" as const,
      enabled: true,
      referencePrice: "750",
      minimumMarginPercent: "5",
      competitiveOffsetNgn: "1",
      minimumDifferenceNgn: "1",
      minimumCompetitorLiquidityNgn: "0",
      minRecentOrderNum: 10,
      minRecentExecuteRate: "80",
      pricingParametersUpdatedAt: new Date().toISOString(),
      pauseReason: null,
    };

    expect(() => validateLiveAdUpdate(makeLiveProposal(), ad, liveLimits, settings)).not.toThrow();
  });

  it("rejects mismatched identifiers, market, direction, or stale current prices", () => {
    const ad = makeAd({ id: "1234567890123456789", price: "600" });
    const settings = {
      adId: "1234567890123456789",
      tokenId: "BTC" as const,
      currencyId: "NGN" as const,
      side: "0" as const,
      enabled: true,
      referencePrice: "750",
      minimumMarginPercent: "5",
      competitiveOffsetNgn: "1",
      minimumDifferenceNgn: "1",
      minimumCompetitorLiquidityNgn: "0",
      minRecentOrderNum: 10,
      minRecentExecuteRate: "80",
      pricingParametersUpdatedAt: new Date().toISOString(),
      pauseReason: null,
    };
    expect(() => validateLiveAdUpdate(makeLiveProposal({ ownAdId: "123" }), ad, liveLimits, settings))
      .toThrow("Advertisement ID");
    expect(() => validateLiveAdUpdate(makeLiveProposal({ tokenId: "USDT" }), ad, liveLimits, settings))
      .toThrow("asset or fiat");
    expect(() => validateLiveAdUpdate(makeLiveProposal({ side: "1" }), ad, liveLimits, settings))
      .toThrow("trading direction");
    expect(() => validateLiveAdUpdate(makeLiveProposal({ currentPrice: "650" }), ad, liveLimits, settings))
      .toThrow("price changed");
  });

  it("rejects offline ads, variable-price ads, and invalid amount limits", () => {
    const baseAd = makeAd({ id: "1234567890123456789" });
    const settings = {
      adId: "1234567890123456789",
      tokenId: "BTC" as const,
      currencyId: "NGN" as const,
      side: "0" as const,
      enabled: true,
      referencePrice: "750",
      minimumMarginPercent: "5",
      competitiveOffsetNgn: "1",
      minimumDifferenceNgn: "1",
      minimumCompetitorLiquidityNgn: "0",
      minRecentOrderNum: 10,
      minRecentExecuteRate: "80",
      pricingParametersUpdatedAt: new Date().toISOString(),
      pauseReason: null,
    };
    expect(() => validateLiveAdUpdate(makeLiveProposal(), { ...baseAd, status: 20 }, liveLimits, settings))
      .toThrow("online fixed-price");
    expect(() => validateLiveAdUpdate(makeLiveProposal(), { ...baseAd, priceType: "1" }, liveLimits, settings))
      .toThrow("online fixed-price");
    expect(() => validateLiveAdUpdate(makeLiveProposal(), { ...baseAd, minAmount: "100", maxAmount: "10" }, liveLimits, settings))
      .toThrow("limits are invalid");
  });

  it("rejects prices outside configured bounds or beyond the maximum change", () => {
    const ad = makeAd({ id: "1234567890123456789", price: "600" });
    const settings = {
      adId: "1234567890123456789",
      tokenId: "BTC" as const,
      currencyId: "NGN" as const,
      side: "0" as const,
      enabled: true,
      referencePrice: "750",
      minimumMarginPercent: "5",
      competitiveOffsetNgn: "1",
      minimumDifferenceNgn: "1",
      minimumCompetitorLiquidityNgn: "0",
      minRecentOrderNum: 10,
      minRecentExecuteRate: "80",
      pricingParametersUpdatedAt: new Date().toISOString(),
      pauseReason: null,
    };
    expect(() => validateLiveAdUpdate(makeLiveProposal({ proposedPrice: "400", priceDeltaNgn: "200" }), ad, liveLimits, settings))
      .toThrow("price boundaries");
    expect(() => validateLiveAdUpdate(
      makeLiveProposal({ currentPrice: "50", proposedPrice: "700", priceDeltaNgn: "650" }),
      { ...ad, price: "50" },
      liveLimits,
      settings,
    ))
      .toThrow("maximum change");
    expect(() => validateLiveAdUpdate(makeLiveProposal({ priceDeltaNgn: "99" }), ad, liveLimits, settings))
      .toThrow("price change is invalid");
  });

  it("requires read-write Advertising only, without P2P-order or Wallet permissions", () => {
    const permissions = {
      apiKey: "test-key",
      readOnly: 0,
      permissions: { FiatP2P: ["Advertising"], Wallet: [] },
    };
    expect(() => validateP2PLiveApiKeyPermissions(permissions, "test-key")).not.toThrow();
    expect(() => validateP2PLiveApiKeyPermissions({ ...permissions, readOnly: 1 }, "test-key"))
      .toThrow("read-write Advertising");
    expect(() => validateP2PLiveApiKeyPermissions({
      ...permissions,
      permissions: { FiatP2P: ["Advertising", "FiatP2POrder"], Wallet: [] },
    }, "test-key")).toThrow("P2P order permissions");
    expect(() => validateP2PLiveApiKeyPermissions({
      ...permissions,
      permissions: { FiatP2P: ["Advertising"], Wallet: ["Withdraw"] },
    }, "test-key")).toThrow("Wallet transfer or withdrawal");
    expect(() => validateP2PLiveApiKeyPermissions({
      ...permissions,
      permissions: { FiatP2P: ["Advertising"], Wallet: [], Spot: ["SpotTrade"] },
    }, "test-key")).toThrow("only the FiatP2P Advertising");
  });

  it("recognizes Bybit authentication and permission failures for automatic pause", () => {
    for (const retCode of [10003, 10004, 10005, 10007]) {
      expect(isBybitAuthenticationError(new BybitRequestError("auth failure", {
        retryable: false,
        retCode,
      }))).toBe(true);
    }
    expect(isBybitAuthenticationError(new BybitRequestError("rate limited", {
      retryable: true,
      retCode: 10006,
    }))).toBe(false);
  });

  it("preserves the exact payment method IDs returned for the ad", () => {
    const ad = makeAd({
      id: "1234567890123456789",
      payments: ["14", "15"],
      paymentTerms: [
        { id: "my-bank-method-1", paymentType: "14" },
        { id: "my-bank-method-2", paymentType: "15" },
      ],
    });

    expect(resolveAdPaymentIds(ad, userPayments)).toEqual([
      "my-bank-method-1",
      "my-bank-method-2",
    ]);
    expect(() => resolveAdPaymentIds({ ...ad, paymentTerms: undefined }, userPayments))
      .toThrow("exact payment method IDs");
    expect(() => resolveAdPaymentIds(ad, [{ id: "my-bank-method-1", paymentType: "15" }]))
      .toThrow("verify an advertisement payment method");
  });

  it("rejects stale or future-dated proposals", () => {
    const now = Date.now();
    expect(() => validateProposalAge(new Date(now - 10_000).toISOString(), now, 30_000)).not.toThrow();
    expect(() => validateProposalAge(new Date(now - 180_000).toISOString(), now, 30_000))
      .toThrow("Price proposal is stale");
    expect(() => validateProposalAge(new Date(now + 60_000).toISOString(), now, 30_000))
      .toThrow("Price proposal is stale");
  });
});
