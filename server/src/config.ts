import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(configDirectory, "../../.env") });

const bybitBaseUrl = process.env.BYBIT_BASE_URL?.trim();
const defaultBybitBaseUrl = process.env.BYBIT_TESTNET === "true"
  ? "https://api-testnet.bybit.com"
  : "https://api.bybit.com";

function requiredSecret(name: string): string {
  const value = process.env[name];
  if (!value || value.length < 32) {
    throw new Error(`${name} must be set to at least 32 characters`);
  }
  return value;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  clientOrigin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
  databaseUrl: process.env.DATABASE_URL ?? "",
  jwtSecret: process.env.JWT_SECRET ?? "development-only-secret-change-before-production",
  adminUsername: process.env.ADMIN_USERNAME ?? "admin",
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  secureCookie: process.env.SESSION_COOKIE_SECURE === "true",
  bybitApiKey: process.env.BYBIT_API_KEY ?? "",
  bybitApiSecret: process.env.BYBIT_API_SECRET ?? "",
  bybitTestnet: process.env.BYBIT_TESTNET === "true",
  bybitBaseUrl: (bybitBaseUrl || defaultBybitBaseUrl).replace(/\/$/, ""),
  redisUrl: process.env.REDIS_URL?.trim() ?? "",
  redisMarketDataTtlSec: Number(process.env.REDIS_MARKET_DATA_TTL_SEC ?? 5),
  redisEnabled: process.env.REDIS_ENABLED !== "false" && Boolean(process.env.REDIS_URL?.trim()),
  p2pAutoScanEnabled: process.env.P2P_AUTO_SCAN !== "false",
  p2pScanIntervalMs: Number(process.env.P2P_SCAN_INTERVAL_MS ?? 5_000),
  p2pLargeChangeThresholdNgn: Number(process.env.P2P_LARGE_CHANGE_THRESHOLD_NGN ?? 600),
  p2pLiveMinPriceNgn: process.env.P2P_LIVE_MIN_PRICE_NGN?.trim() ?? "",
  p2pLiveMaxPriceNgn: process.env.P2P_LIVE_MAX_PRICE_NGN?.trim() ?? "",
  p2pLiveMaxChangeNgn: process.env.P2P_LIVE_MAX_CHANGE_NGN?.trim() || "600",
  p2pMinimumUpdateIntervalMs: Number(process.env.P2P_MINIMUM_UPDATE_INTERVAL_MS ?? 60_000),
  p2pMaximumUpdatesPerAdPerMinute: Number(process.env.P2P_MAX_UPDATES_PER_AD_PER_MINUTE ?? 1),
  p2pMaximumUpdatesPerDay: Number(process.env.P2P_MAX_UPDATES_PER_DAY ?? 100),
  p2pMaximumMarketDataAgeMs: Number(
    process.env.P2P_MAX_MARKET_DATA_AGE_MS
      ?? Math.max(Number(process.env.P2P_SCAN_INTERVAL_MS ?? 5_000) * 3, 15_000),
  ),
  p2pReferenceMaximumAgeDays: Number(process.env.P2P_REFERENCE_MAX_AGE_DAYS ?? 30),
};

export function validateProductionConfig(): void {
  if (!Number.isSafeInteger(config.p2pScanIntervalMs)
    || config.p2pScanIntervalMs < 5_000
    || config.p2pScanIntervalMs > 300_000) {
    throw new Error("P2P_SCAN_INTERVAL_MS must be an integer between 5000 and 300000");
  }
  if (!Number.isFinite(config.p2pLargeChangeThresholdNgn) || config.p2pLargeChangeThresholdNgn < 0) {
    throw new Error("P2P_LARGE_CHANGE_THRESHOLD_NGN must be a non-negative number");
  }
  if (!Number.isSafeInteger(config.p2pMinimumUpdateIntervalMs) || config.p2pMinimumUpdateIntervalMs < 60_000) {
    throw new Error("P2P_MINIMUM_UPDATE_INTERVAL_MS must be an integer of at least 60000");
  }
  if (!Number.isSafeInteger(config.p2pMaximumUpdatesPerAdPerMinute)
    || config.p2pMaximumUpdatesPerAdPerMinute < 1
    || config.p2pMaximumUpdatesPerAdPerMinute > 2) {
    throw new Error("P2P_MAX_UPDATES_PER_AD_PER_MINUTE must be an integer between 1 and 2");
  }
  if (!Number.isSafeInteger(config.p2pMaximumUpdatesPerDay)
    || config.p2pMaximumUpdatesPerDay < 1) {
    throw new Error("P2P_MAX_UPDATES_PER_DAY must be a positive integer");
  }
  if (!Number.isSafeInteger(config.p2pMaximumMarketDataAgeMs)
    || config.p2pMaximumMarketDataAgeMs < config.p2pScanIntervalMs) {
    throw new Error("P2P_MAX_MARKET_DATA_AGE_MS must be at least P2P_SCAN_INTERVAL_MS");
  }
  if (!Number.isSafeInteger(config.p2pReferenceMaximumAgeDays)
    || config.p2pReferenceMaximumAgeDays < 1) {
    throw new Error("P2P_REFERENCE_MAX_AGE_DAYS must be a positive integer");
  }
  if (config.nodeEnv === "production") {
    requiredSecret("JWT_SECRET");
    requiredSecret("ADMIN_PASSWORD");
    if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  }
}
