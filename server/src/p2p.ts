import { z } from "zod";
import { BybitRequestError, bybitRequest, type BybitResponse } from "./bybit.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { getCachedMarketData, setCachedMarketData } from "./redis.js";

const idString = z.union([z.string(), z.number()]).transform(String);
const sideString = z.union([z.string(), z.number()]).transform(String);
const countValue = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/).transform(Number),
]);

const paymentTermSchema = z.object({
  id: z.string(),
  paymentType: idString,
});

const adSchema = z.object({
  id: z.string(),
  userId: idString.optional(),
  nickName: z.string().optional(),
  tokenId: z.string(),
  currencyId: z.string(),
  side: sideString,
  price: z.union([z.string(), z.number()]).transform(String),
  payments: z.array(idString).default([]),
  paymentTerms: z.array(paymentTermSchema).optional(),
  authTag: z.array(z.string()).default([]),
  isOnline: z.boolean().optional(),
  status: z.union([z.number(), z.string()]).transform(Number),
  recentOrderNum: z.union([z.number(), z.string()]).optional(),
  recentExecuteRate: z.union([z.number(), z.string()]).optional(),
  priceType: z.union([z.string(), z.number()]).transform(String).optional(),
  premium: z.union([z.string(), z.number()]).transform(String).optional(),
  quantity: z.union([z.string(), z.number()]).transform(String).optional(),
  lastQuantity: z.union([z.string(), z.number()]).transform(String).optional(),
  minAmount: z.union([z.string(), z.number()]).transform(String).optional(),
  maxAmount: z.union([z.string(), z.number()]).transform(String).optional(),
  remark: z.string().optional(),
  tradingPreferenceSet: z.record(z.string(), z.unknown()).optional(),
  paymentPeriod: z.union([z.string(), z.number()]).transform(String).optional(),
});

const adListSchema = z.object({
  count: countValue,
  items: z.array(adSchema),
});

const paymentSchema = z.object({
  id: z.string(),
  paymentType: idString,
  online: z.union([z.string(), z.number()]).optional(),
});

const paymentListSchema = z.array(paymentSchema);
const apiKeyInfoSchema = z.object({
  apiKey: z.string(),
  readOnly: z.union([z.number(), z.string()]).transform(Number),
  permissions: z.object({
    FiatP2P: z.array(z.string()),
    Wallet: z.array(z.string()),
  }).passthrough(),
});

export type P2PAd = z.infer<typeof adSchema>;
export type P2PPayment = z.infer<typeof paymentSchema>;

export type P2PPriceProposal = {
  tokenId: "BTC" | "USDT";
  currencyId: "NGN";
  side: "0" | "1";
  ownAdId: string;
  currentPrice: string;
  competitorAdId: string;
  competitorNickname: string;
  competitorAuthTags: string[];
  proposedPrice: string;
  priceDeltaNgn: string;
  largeChange: boolean;
  matchingPaymentTypes: string[];
  estimatedProfitPerToken: string;
  projectedMarginPercent: string;
  minimumProfitablePrice: string;
  minimumDifferenceNgn: string;
};

export type P2PAdRepricingConfig = {
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
  referenceUpdatedAt: string | null;
  pauseReason?: string | null;
};

export type P2PUpdatePayload = {
  id: string;
  priceType: string;
  premium: string;
  price: string;
  minAmount: string;
  maxAmount: string;
  remark: string;
  tradingPreferenceSet: Record<string, unknown>;
  paymentIds: string[];
  actionType: "MODIFY";
  quantity: string;
  paymentPeriod: string;
};

const tradingPreferenceFields = [
  "hasUnPostAd",
  "isKyc",
  "isEmail",
  "isMobile",
  "hasRegisterTime",
  "registerTimeThreshold",
  "orderFinishNumberDay30",
  "completeRateDay30",
  "nationalLimit",
  "hasOrderFinishNumberDay30",
  "hasCompleteRateDay30",
  "hasNationalLimit",
] as const;

const pageSize = 300;
const ownAdsPageSize = 30;
const maximumPages = 100;
const priceScale = 10n ** 10n;
const percentScale = 10_000n;
let requestQueue: Promise<void> = Promise.resolve();
let nextP2PRequestAt = 0;

export type P2PRequestMetrics = {
  requestCount: number;
  totalLatencyMs: number;
  averageLatencyMs: number;
  rateLimitWarnings: number;
};

type MutableP2PRequestMetrics = Pick<P2PRequestMetrics, "requestCount" | "totalLatencyMs" | "rateLimitWarnings">;

function recordP2PRequest(metrics: MutableP2PRequestMetrics | undefined, latencyMs: number): void {
  if (!metrics) return;
  metrics.requestCount += 1;
  metrics.totalLatencyMs += latencyMs;
}

export function ngnUnits(value: string, label: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,10}))?$/.exec(value);
  if (!match) {
    throw new Error(`${label} is not a valid NGN price with at most 10 decimal places`);
  }
  const fraction = (match[2] ?? "").padEnd(10, "0");
  return BigInt(match[1]) * priceScale + BigInt(fraction || "0");
}

function percentUnits(value: string, label: string): bigint {
  const match = /^(?:0|[1-9]\d*)(?:\.(\d{1,4}))?$/.exec(value);
  if (!match) throw new Error(`${label} must be a non-negative percentage with at most 4 decimals`);
  const [whole, fraction = ""] = value.split(".");
  const units = BigInt(whole) * percentScale + BigInt(fraction.padEnd(4, "0") || "0");
  if (units > 100n * percentScale) throw new Error(`${label} must not exceed 100 percent`);
  return units;
}

function formatNgnUnits(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = (absolute / priceScale).toString();
  let fraction = (absolute % priceScale).toString().padStart(10, "0").replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function formatPercentUnits(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = (absolute / percentScale).toString();
  const fraction = (absolute % percentScale).toString().padStart(4, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${fraction ? `${whole}.${fraction}` : whole}`;
}

function percentageOf(referencePrice: bigint, percent: bigint): bigint {
  return referencePrice * percent / (100n * percentScale);
}

export function calculateMinimumProfitablePrice(
  side: "0" | "1",
  referencePrice: string,
  minimumMarginPercent: string,
): string {
  const reference = ngnUnits(referencePrice, "Advertisement reference price");
  const margin = percentUnits(minimumMarginPercent, "Minimum profit margin");
  if (reference <= 0n) throw new Error("Advertisement reference price must be greater than zero");
  const requiredMargin = percentageOf(reference, margin);
  const minimum = side === "1"
    ? reference + (reference * margin + 100n * percentScale - 1n) / (100n * percentScale)
    : reference - requiredMargin;
  if (minimum <= 0n) throw new Error("Minimum margin leaves no positive permissible buy price");
  return formatNgnUnits(minimum);
}

function assertP2PCredentials(): void {
  if (!config.bybitApiKey || !config.bybitApiSecret) {
    throw new Error("BYBIT_API_KEY and BYBIT_API_SECRET are required for P2P API access");
  }
}

function validateP2PResult<T>(result: unknown, schema: z.ZodType<T>, endpoint: string): T {
  const parsed = schema.safeParse(result);
  if (!parsed.success) {
    throw new Error(`Bybit P2P ${endpoint} returned an invalid response: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function validateP2PLiveApiKeyPermissions(
  result: unknown,
  expectedApiKey: string,
): void {
  const parsed = apiKeyInfoSchema.safeParse(result);
  if (!parsed.success || parsed.data.apiKey !== expectedApiKey) {
    throw new Error("Could not verify the configured Bybit API key permissions");
  }
  if (parsed.data.readOnly !== 0 || !parsed.data.permissions.FiatP2P.includes("Advertising")) {
    throw new Error("Bybit API key must have read-write Advertising permission for FiatP2P");
  }
  if (parsed.data.permissions.FiatP2P.some((permission) => permission !== "Advertising")) {
    throw new Error("Bybit API key must not have P2P order permissions; only Advertising is allowed");
  }
  if (parsed.data.permissions.Wallet.length > 0) {
    throw new Error("Bybit API key must not have Wallet transfer or withdrawal permissions");
  }
  const otherPermissions = Object.entries(parsed.data.permissions).filter(([category, scopes]) =>
    category !== "FiatP2P" && Array.isArray(scopes) && scopes.length > 0,
  );
  if (otherPermissions.length > 0) {
    throw new Error("Bybit API key must have only the FiatP2P Advertising permission");
  }
}

async function p2pPostResponse(
  endpoint: string,
  body: Record<string, unknown>,
  metrics?: MutableP2PRequestMetrics,
): Promise<BybitResponse> {
  assertP2PCredentials();
  const scheduled = requestQueue.then(async () => {
    const waitMs = Math.max(0, nextP2PRequestAt - Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    nextP2PRequestAt = Date.now() + 250;
  });
  requestQueue = scheduled.then(() => undefined, () => undefined);
  await scheduled;

  const isUpdateEndpoint = endpoint === "/v5/p2p/item/update";
  for (let attempt = 0; ; attempt += 1) {
    const startedAt = Date.now();
    try {
      const response = await bybitRequest("POST", endpoint, body);
      recordP2PRequest(metrics, response.latencyMs);
      if (response.rateLimit.remaining !== null && response.rateLimit.remaining <= 2) {
        if (metrics) metrics.rateLimitWarnings += 1;
        logger.warn({
          endpoint,
          remaining: response.rateLimit.remaining,
          limit: response.rateLimit.limit,
          resetAt: response.rateLimit.resetAt,
        }, "Bybit P2P rate limit is near");
      }
      if (response.rateLimit.remaining === 0
        && response.rateLimit.resetAt
        && response.rateLimit.resetAt > Date.now()) {
        nextP2PRequestAt = Math.max(nextP2PRequestAt, response.rateLimit.resetAt + 50);
      }
      return response;
    } catch (error) {
      recordP2PRequest(metrics, Date.now() - startedAt);
      if (error instanceof BybitRequestError && error.options.rateLimit?.remaining !== null
        && error.options.rateLimit?.remaining !== undefined
        && error.options.rateLimit.remaining <= 2) {
        if (metrics) metrics.rateLimitWarnings += 1;
        const resetAt = error.options.rateLimit.resetAt;
        if (error.options.rateLimit.remaining === 0 && resetAt && resetAt > Date.now()) {
          nextP2PRequestAt = Math.max(nextP2PRequestAt, resetAt + 50);
        }
      }
      const explicitRateLimit = error instanceof BybitRequestError
        && (error.options.retCode === 10006 || error.options.httpStatus === 429);
      if (!(error instanceof BybitRequestError)
        || !error.options.retryable
        || (isUpdateEndpoint && !explicitRateLimit)
        || attempt >= 3) {
        throw error;
      }
      const retryDelayMs = Math.min(3_000, 250 * (2 ** attempt) + Math.floor(Math.random() * 100));
      logger.warn({
        endpoint,
        attempt: attempt + 1,
        retryDelayMs,
        retCode: error.options.retCode,
        httpStatus: error.options.httpStatus,
      }, explicitRateLimit
        ? "Retrying a rate-limited Bybit P2P request"
        : "Retrying a transient Bybit P2P read");
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      const retrySchedule = requestQueue.then(async () => {
        const waitMs = Math.max(0, nextP2PRequestAt - Date.now());
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        nextP2PRequestAt = Date.now() + 250;
      });
      requestQueue = retrySchedule.then(() => undefined, () => undefined);
      await retrySchedule;
    }
  }
}

async function p2pPost<T>(
  endpoint: string,
  body: Record<string, unknown>,
  schema: z.ZodType<T>,
  metrics?: MutableP2PRequestMetrics,
): Promise<T> {
  const response = await p2pPostResponse(endpoint, body, metrics);
  return validateP2PResult(response.result, schema, endpoint);
}

export async function fetchOwnAds(
  tokenId: "BTC" | "USDT",
  side: "0" | "1",
  metrics?: MutableP2PRequestMetrics,
): Promise<P2PAd[]> {
  const firstPage = await p2pPost(
    "/v5/p2p/item/personal/list",
    { tokenId, currencyId: "NGN", side, page: "1", size: String(ownAdsPageSize) },
    adListSchema,
    metrics,
  );
  if (firstPage.count > maximumPages) {
    throw new Error(`Bybit returned too many own-ad pages (${firstPage.count})`);
  }
  const ads = [...firstPage.items];
  for (let page = 2; page <= firstPage.count; page += 1) {
    const nextPage = await p2pPost(
      "/v5/p2p/item/personal/list",
      { tokenId, currencyId: "NGN", side, page: String(page), size: String(ownAdsPageSize) },
      adListSchema,
      metrics,
    );
    ads.push(...nextPage.items);
  }
  return ads;
}

export async function fetchP2POwnAds(metrics?: MutableP2PRequestMetrics): Promise<P2PAd[]> {
  const markets = ["BTC", "USDT"] as const;
  const sides = ["0", "1"] as const;
  return (await Promise.all(markets.flatMap((tokenId) =>
    sides.map((side) => fetchOwnAds(tokenId, side, metrics)),
  ))).flat();
}

async function fetchCompetitorAds(
  tokenId: "BTC" | "USDT",
  side: "0" | "1",
  metrics?: MutableP2PRequestMetrics,
): Promise<P2PAd[]> {
  const cached = await getCachedMarketData(tokenId, "NGN", side);
  if (cached) return cached.ads as P2PAd[];

  const firstPage = await p2pPost(
    "/v5/p2p/item/online",
    { tokenId, currencyId: "NGN", side, page: "1", size: String(pageSize) },
    adListSchema,
    metrics,
  );
  const pageCount = Math.ceil(firstPage.count / pageSize);
  if (pageCount > maximumPages) {
    throw new Error(`Bybit returned too many competitor-ad pages (${pageCount})`);
  }
  const ads = [...firstPage.items];
  for (let page = 2; page <= pageCount; page += 1) {
    const nextPage = await p2pPost(
      "/v5/p2p/item/online",
      { tokenId, currencyId: "NGN", side, page: String(page), size: String(pageSize) },
      adListSchema,
      metrics,
    );
    ads.push(...nextPage.items);
  }
  await setCachedMarketData(tokenId, "NGN", side, ads);
  return ads;
}

export async function fetchP2PUserPayments(): Promise<P2PPayment[]> {
  return p2pPost("/v5/p2p/user/payment/list", {}, paymentListSchema);
}

export function buildP2PPriceProposals(
  ownAds: P2PAd[],
  marketAdsByKey: ReadonlyMap<string, P2PAd[]>,
  repricingConfigs: ReadonlyMap<string, P2PAdRepricingConfig>,
  largeChangeThresholdNgn: number,
  referenceMaximumAgeDays: number,
): P2PPriceProposal[] {
  const ownUserIds = new Set(ownAds.flatMap((ad) => ad.userId ? [ad.userId] : []));
  const threshold = ngnUnits(String(largeChangeThresholdNgn), "Large-change threshold");
  const proposals: P2PPriceProposal[] = [];

  for (const ownAd of ownAds) {
    if (ownAd.status !== 10 || (ownAd.side !== "0" && ownAd.side !== "1")) continue;
    if (ownAd.priceType !== "0") continue;
    if (ownAd.tokenId !== "BTC" && ownAd.tokenId !== "USDT") continue;
    if (ownAd.currencyId !== "NGN" || !ownAd.payments.length
      || !ownAd.minAmount || !ownAd.maxAmount) continue;

    const repricingConfig = repricingConfigs.get(ownAd.id);
    if (!repricingConfig || !repricingConfig.referencePrice
      || !repricingConfig.minimumMarginPercent || !repricingConfig.referenceUpdatedAt) continue;
    if (repricingConfig.tokenId !== ownAd.tokenId
      || repricingConfig.currencyId !== ownAd.currencyId
      || repricingConfig.side !== ownAd.side) continue;

    const referenceUpdatedAt = new Date(repricingConfig.referenceUpdatedAt).getTime();
    if (!Number.isFinite(referenceUpdatedAt)
      || Date.now() - referenceUpdatedAt > referenceMaximumAgeDays * 86_400_000
      || referenceUpdatedAt > Date.now() + 30_000) continue;

    const marketKey = `${ownAd.tokenId}:${ownAd.currencyId}:${ownAd.side}`;
    const ownPaymentTypes = new Set(ownAd.payments);
    const ownMinimumAmount = ngnUnits(ownAd.minAmount, `Own ad ${ownAd.id} minimum amount`);
    const ownMaximumAmount = ngnUnits(ownAd.maxAmount, `Own ad ${ownAd.id} maximum amount`);
    const minimumLiquidity = ngnUnits(
      repricingConfig.minimumCompetitorLiquidityNgn,
      `Ad ${ownAd.id} minimum competitor liquidity`,
    );
    const candidates = (marketAdsByKey.get(marketKey) ?? []).filter((ad) => {
      if (ad.id === ownAd.id
        || (ad.userId && ownUserIds.has(ad.userId))
        || ad.tokenId !== ownAd.tokenId
        || ad.currencyId !== ownAd.currencyId
        || ad.side !== ownAd.side
        || ad.status !== 10
        || ad.isOnline === false
        || !ad.authTag.includes("VA")
        || ad.authTag.includes("BA")
        || !ad.payments.some((paymentType) => ownPaymentTypes.has(paymentType))
        || !ad.minAmount || !ad.maxAmount || !ad.lastQuantity) return false;

      const recentOrderCount = ad.recentOrderNum === undefined
        ? undefined
        : Number(ad.recentOrderNum);
      const recentExecuteRate = ad.recentExecuteRate === undefined
        ? undefined
        : Number(ad.recentExecuteRate);
      if ((recentOrderCount === undefined && repricingConfig.minRecentOrderNum > 0)
        || (recentOrderCount !== undefined
          && (!Number.isFinite(recentOrderCount)
            || recentOrderCount < repricingConfig.minRecentOrderNum))
        || (recentExecuteRate === undefined
          && Number(repricingConfig.minRecentExecuteRate) > 0)
        || (recentExecuteRate !== undefined
          && (!Number.isFinite(recentExecuteRate)
            || recentExecuteRate < Number(repricingConfig.minRecentExecuteRate)))) return false;

      try {
        const competitorMinimum = ngnUnits(ad.minAmount, `Competitor ad ${ad.id} minimum amount`);
        const competitorMaximum = ngnUnits(ad.maxAmount, `Competitor ad ${ad.id} maximum amount`);
        const competitorPrice = ngnUnits(ad.price, `Competitor ad ${ad.id} price`);
        const competitorQuantity = ngnUnits(ad.lastQuantity, `Competitor ad ${ad.id} available quantity`);
        const availableQuote = competitorPrice * competitorQuantity / priceScale;
        return competitorPrice > 0n
          && competitorMinimum <= ownMaximumAmount
          && competitorMaximum >= ownMinimumAmount
          && availableQuote >= ownMinimumAmount
          && availableQuote >= minimumLiquidity;
      } catch {
        return false;
      }
    });
    candidates.sort((left, right) => {
      const leftPrice = ngnUnits(left.price, `Competitor ad ${left.id} price`);
      const rightPrice = ngnUnits(right.price, `Competitor ad ${right.id} price`);
      if (leftPrice === rightPrice) return left.id.localeCompare(right.id);
      if (ownAd.side === "1") return leftPrice < rightPrice ? -1 : 1;
      return leftPrice > rightPrice ? -1 : 1;
    });
    const competitor = candidates[0];
    if (!competitor) continue;

    const matchingPaymentTypes = ownAd.payments.filter((paymentType) =>
      competitor.payments.includes(paymentType),
    );

    const currentPrice = ngnUnits(ownAd.price, `Own ad ${ownAd.id} price`);
    const targetPrice = ngnUnits(competitor.price, `Competitor ad ${competitor.id} price`);
    if (currentPrice <= 0n || targetPrice <= 0n) {
      throw new Error(`Invalid price returned for ad ${ownAd.id} or competitor ${competitor.id}`);
    }
    const offset = ngnUnits(
      repricingConfig.competitiveOffsetNgn,
      `Ad ${ownAd.id} competitive offset`,
    );
    const proposedPrice = ownAd.side === "1" ? targetPrice - offset : targetPrice + offset;
    if (proposedPrice <= 0n) continue;

    const referencePrice = ngnUnits(repricingConfig.referencePrice, `Ad ${ownAd.id} reference price`);
    const marginPercent = percentUnits(
      repricingConfig.minimumMarginPercent,
      `Ad ${ownAd.id} minimum margin`,
    );
    if (referencePrice <= 0n) continue;
    if (ownAd.side === "0" && marginPercent >= 100n * percentScale) continue;
    const minimumProfitablePriceText = calculateMinimumProfitablePrice(
      ownAd.side,
      repricingConfig.referencePrice,
      repricingConfig.minimumMarginPercent,
    );
    const minimumProfitablePrice = ngnUnits(minimumProfitablePriceText, "Minimum profitable price");
    if (minimumProfitablePrice <= 0n) continue;
    if ((ownAd.side === "1" && proposedPrice < minimumProfitablePrice)
      || (ownAd.side === "0" && proposedPrice > minimumProfitablePrice)) continue;

    const actualDelta = currentPrice > proposedPrice
      ? currentPrice - proposedPrice
      : proposedPrice - currentPrice;
    const estimatedProfit = ownAd.side === "1"
      ? proposedPrice - referencePrice
      : referencePrice - proposedPrice;
    const projectedMargin = estimatedProfit * (100n * percentScale) / referencePrice;
    proposals.push({
      tokenId: ownAd.tokenId,
      currencyId: "NGN",
      side: ownAd.side,
      ownAdId: ownAd.id,
      currentPrice: ownAd.price,
      competitorAdId: competitor.id,
      competitorNickname: competitor.nickName ?? "",
      competitorAuthTags: competitor.authTag,
      proposedPrice: formatNgnUnits(proposedPrice),
      priceDeltaNgn: formatNgnUnits(actualDelta),
      largeChange: actualDelta > threshold,
      matchingPaymentTypes,
      estimatedProfitPerToken: formatNgnUnits(estimatedProfit),
      projectedMarginPercent: formatPercentUnits(projectedMargin),
      minimumProfitablePrice: formatNgnUnits(minimumProfitablePrice),
      minimumDifferenceNgn: repricingConfig.minimumDifferenceNgn,
    });
  }
  return proposals;
}

export function buildAdUpdatePayload(
  ownAd: P2PAd,
  proposedPrice: string,
  paymentIds: string[],
): P2PUpdatePayload {
  if (!ownAd.priceType || ownAd.premium === undefined || !ownAd.quantity
    || !ownAd.minAmount || !ownAd.maxAmount || !ownAd.paymentPeriod
    || !ownAd.tradingPreferenceSet) {
    throw new Error(`Ad ${ownAd.id} is missing required fields for the documented update request`);
  }
  if (!paymentIds.length || paymentIds.length > 5) {
    throw new Error("The documented update endpoint requires between 1 and 5 payment IDs");
  }
  const tradingPreferenceSet: Record<string, unknown> = {};
  for (const field of tradingPreferenceFields) {
    const value = ownAd.tradingPreferenceSet[field];
    if (typeof value === "string" || typeof value === "number") {
      tradingPreferenceSet[field] = String(value);
    }
  }
  return {
    id: ownAd.id,
    priceType: ownAd.priceType,
    premium: ownAd.premium,
    price: proposedPrice,
    minAmount: ownAd.minAmount,
    maxAmount: ownAd.maxAmount,
    remark: ownAd.remark ?? "",
    tradingPreferenceSet,
    paymentIds,
    actionType: "MODIFY",
    quantity: ownAd.quantity,
    paymentPeriod: ownAd.paymentPeriod,
  };
}

export async function updateP2PAd(payload: P2PUpdatePayload): Promise<BybitResponse> {
  const response = await p2pPostResponse("/v5/p2p/item/update", payload);
  validateP2PResult(response.result, z.unknown(), "/v5/p2p/item/update");
  return response;
}

export async function fetchP2PAdDetails(itemId: string): Promise<P2PAd> {
  return p2pPost("/v5/p2p/item/info", { itemId }, adSchema);
}

export async function verifyP2PLivePermissions(): Promise<{
  ownAdCount: number;
  paymentMethodCount: number;
}> {
  assertP2PCredentials();
  const response = await bybitRequest("GET", "/v5/user/query-api");
  validateP2PLiveApiKeyPermissions(response.result, config.bybitApiKey);

  const [ownAds, payments] = await Promise.all([
    fetchOwnAds("BTC", "0"),
    fetchP2PUserPayments(),
  ]);
  return { ownAdCount: ownAds.length, paymentMethodCount: payments.length };
}

export async function scanP2PMarket(
  largeChangeThresholdNgn: number,
  repricingConfigs: ReadonlyMap<string, P2PAdRepricingConfig>,
  referenceMaximumAgeDays: number,
): Promise<{ proposals: P2PPriceProposal[]; metrics: P2PRequestMetrics }> {
  const markets = ["BTC", "USDT"] as const;
  const sides = ["0", "1"] as const;
  const metrics: MutableP2PRequestMetrics = {
    requestCount: 0,
    totalLatencyMs: 0,
    rateLimitWarnings: 0,
  };
  const [ownAds, marketResults] = await Promise.all([
    fetchP2POwnAds(metrics),
    Promise.all(markets.flatMap((tokenId) =>
      sides.map(async (side) => ({
        key: `${tokenId}:NGN:${side}`,
        ads: await fetchCompetitorAds(tokenId, side, metrics),
      })),
    )),
  ]);
  const marketAdsByKey = new Map<string, P2PAd[]>();

  for (const result of marketResults) marketAdsByKey.set(result.key, result.ads);
  const proposals = buildP2PPriceProposals(
    ownAds,
    marketAdsByKey,
    repricingConfigs,
    largeChangeThresholdNgn,
    referenceMaximumAgeDays,
  );
  return {
    proposals,
    metrics: {
      ...metrics,
      averageLatencyMs: metrics.requestCount
        ? Math.round(metrics.totalLatencyMs / metrics.requestCount)
        : 0,
    },
  };
}
