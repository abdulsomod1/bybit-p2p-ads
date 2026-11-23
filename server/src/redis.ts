import crypto from "node:crypto";
import Redis from "ioredis";
import { config } from "./config.js";
import { logger } from "./logger.js";

export const serverInstanceId: string = crypto.randomUUID();

export type RedisHealth = {
  connected: boolean;
  latencyMs: number | null;
  mode: "redis" | "in_memory";
};

export type CachedMarketData = {
  ads: unknown[];
  fetchedAt: number;
};

export type RateLimitCheckResult = {
  allowed: boolean;
  reason?: string;
  currentCount?: number;
  limit?: number;
};

interface InMemoryCacheEntry {
  data: unknown;
  expiresAt: number;
}

const inMemoryCache = new Map<string, InMemoryCacheEntry>();
const inMemoryRateLimits = new Map<string, { count: number; resetAt: number }>();
const inMemoryLocks = new Set<string>();

function cleanInMemoryCache(): void {
  const now = Date.now();
  for (const [key, entry] of inMemoryCache) {
    if (entry.expiresAt <= now) inMemoryCache.delete(key);
  }
}

function cleanInMemoryRateLimits(): void {
  const now = Date.now();
  for (const [key, entry] of inMemoryRateLimits) {
    if (entry.resetAt <= now) inMemoryRateLimits.delete(key);
  }
}

let redis: Redis | null = null;
let redisAvailable = false;

function createRedisClient(url: string): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times: number) => {
      if (times > 10) {
        logger.warn({ times }, "Redis reconnection attempts exhausted; continuing in degraded mode");
        return null;
      }
      const delay = Math.min(500 * 2 ** times, 30_000);
      logger.info({ attempt: times, delayMs: delay }, "Redis reconnecting");
      return delay;
    },
    enableReadyCheck: true,
    lazyConnect: false,
  });

  client.on("connect", () =>
    logger.info({ host: client.options.host }, "Redis connecting"));
  client.on("ready", () => {
    redisAvailable = true;
    logger.info({ host: client.options.host }, "Redis ready");
  });
  client.on("error", (err: Error) => {
    if (redisAvailable) {
      logger.warn({ errorName: err.name }, "Redis error; falling back to in-memory");
    }
    redisAvailable = false;
  });
  client.on("close", () => {
    redisAvailable = false;
    logger.warn({}, "Redis connection closed");
  });

  return client;
}

export async function initRedis(): Promise<void> {
  if (!config.redisEnabled || !config.redisUrl) {
    logger.info({}, "Redis is not configured; operating in single-instance in-memory mode");
    return;
  }
  redis = createRedisClient(config.redisUrl);

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      logger.warn({}, "Redis initial connection timed out; continuing in single-instance mode");
      resolve();
    }, 5_000);
    if (redis) {
      redis.once("ready", () => { clearTimeout(timeout); resolve(); });
      redis.once("error", () => { clearTimeout(timeout); resolve(); });
    } else {
      clearTimeout(timeout);
      resolve();
    }
  });
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    redisAvailable = false;
    await redis.quit().catch(() => { /* ignore */ });
    redis = null;
    logger.info({}, "Redis connection closed");
  }
}

export async function checkRedisHealth(): Promise<RedisHealth> {
  cleanInMemoryCache();
  cleanInMemoryRateLimits();
  if (!redis || !redisAvailable) {
    return { connected: false, latencyMs: null, mode: "in_memory" };
  }
  const startedAt = Date.now();
  try {
    await redis.ping();
    return { connected: true, latencyMs: Date.now() - startedAt, mode: "redis" };
  } catch {
    redisAvailable = false;
    return { connected: false, latencyMs: null, mode: "in_memory" };
  }
}

function redisCacheKey(tokenId: string, currencyId: string, side: string): string {
  return `p2p:market:${tokenId}:${currencyId}:${side}`;
}

export async function getCachedMarketData(
  tokenId: string,
  currencyId: string,
  side: string,
): Promise<CachedMarketData | null> {
  cleanInMemoryCache();
  const key = redisCacheKey(tokenId, currencyId, side);

  if (redis && redisAvailable) {
    try {
      const raw = await redis.hgetall(key);
      if (raw && raw.ads && raw.fetchedAt) {
        const ttl = await redis.ttl(key);
        if (ttl > 0) {
          return { ads: JSON.parse(raw.ads as string), fetchedAt: Number(raw.fetchedAt) };
        }
      }
    } catch (err) {
      logger.warn(
        { errorName: err instanceof Error ? err.name : "UnknownError", key },
        "Redis market cache read failed; using in-memory fallback",
      );
    }
  }

  const entry = inMemoryCache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.data as CachedMarketData;
  }
  inMemoryCache.delete(key);
  return null;
}

export async function setCachedMarketData(
  tokenId: string,
  currencyId: string,
  side: string,
  ads: unknown[],
): Promise<void> {
  const key = redisCacheKey(tokenId, currencyId, side);
  const ttlSec = config.redisMarketDataTtlSec;
  const fetchedAt = Date.now();
  const payload: CachedMarketData = { ads, fetchedAt };

  if (redis && redisAvailable) {
    try {
      await redis
        .multi()
        .hset(key, "ads", JSON.stringify(ads), "fetchedAt", String(fetchedAt))
        .expire(key, ttlSec)
        .exec();
      return;
    } catch (err) {
      logger.warn(
        { errorName: err instanceof Error ? err.name : "UnknownError", key },
        "Redis market cache write failed; using in-memory fallback",
      );
    }
  }

  inMemoryCache.set(key, { data: payload, expiresAt: fetchedAt + ttlSec * 1_000 });
}

const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_sec = tonumber(ARGV[2])
local current = redis.call("GET", key)
if current then
  local count = tonumber(current)
  if count >= limit then
    local ttl = redis.call("TTL", key)
    return {0, count, ttl}
  end
  local new_count = redis.call("INCR", key)
  return {1, new_count, -1}
else
  redis.call("SET", key, 1, "EX", window_sec)
  return {1, 1, window_sec}
end
`;

export async function checkDistributedRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitCheckResult> {
  cleanInMemoryRateLimits();
  const now = Date.now();

  if (redis && redisAvailable) {
    try {
      const result = await redis.eval(
        RATE_LIMIT_SCRIPT, 1, key,
        String(limit), String(windowSeconds), String(now),
      ) as [number, number, number];
      const [allowed, currentCount, ttl] = result;
      if (allowed === 1) return { allowed: true, currentCount, limit };
      return {
        allowed: false,
        reason: `Rate limit reached: ${currentCount}/${limit}; resets in ${ttl}s`,
        currentCount, limit,
      };
    } catch (err) {
      logger.warn(
        { errorName: err instanceof Error ? err.name : "UnknownError", key },
        "Redis rate limit check failed; using in-memory fallback",
      );
    }
  }

  const entry = inMemoryRateLimits.get(key);
  if (entry) {
    if (entry.resetAt <= now) {
      inMemoryRateLimits.delete(key);
    } else if (entry.count >= limit) {
      const remainingSec = Math.ceil((entry.resetAt - now) / 1_000);
      return {
        allowed: false,
        reason: `In-memory rate limit: ${entry.count}/${limit}; resets in ${remainingSec}s`,
        currentCount: entry.count, limit,
      };
    } else {
      entry.count += 1;
      return { allowed: true, currentCount: entry.count, limit };
    }
  }
  inMemoryRateLimits.set(key, { count: 1, resetAt: now + windowSeconds * 1_000 });
  return { allowed: true, currentCount: 1, limit };
}

export type DistributedLock = {
  key: string;
  instanceId: string;
  released: boolean;
};

const SCAN_LOCK_KEY = "p2p:lock:scan";
const SCAN_LOCK_TTL_SEC = 30;
const AD_UPDATE_LOCK_PREFIX = "p2p:lock:ad:";
const AD_UPDATE_LOCK_TTL_SEC = 120;

const RELEASE_OWNED_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

export async function tryAcquireScanLock(instanceId: string): Promise<DistributedLock> {
  const lock: DistributedLock = { key: SCAN_LOCK_KEY, instanceId, released: false };

  if (redis && redisAvailable) {
    try {
      const acquired = await redis.set(SCAN_LOCK_KEY, instanceId, "EX", SCAN_LOCK_TTL_SEC, "NX");
      if (acquired === "OK") {
        logger.debug({ instanceId, ttlSec: SCAN_LOCK_TTL_SEC }, "Acquired distributed scan lock");
        return lock;
      }
      const holder = await redis.get(SCAN_LOCK_KEY);
      logger.debug({ instanceId, holder }, "Distributed scan lock already held");
      return lock;
    } catch (err) {
      logger.warn(
        { errorName: err instanceof Error ? err.name : "UnknownError" },
        "Redis scan lock failed; using in-memory (single-instance only)",
      );
    }
  }

  if (inMemoryLocks.has(SCAN_LOCK_KEY)) {
    logger.debug({ instanceId }, "In-memory scan lock already held");
    return lock;
  }
  inMemoryLocks.add(SCAN_LOCK_KEY);
  logger.debug({ instanceId }, "Acquired in-memory scan lock (single-instance mode)");
  return lock;
}

export async function releaseScanLock(lock: DistributedLock): Promise<void> {
  if (lock.released) return;
  lock.released = true;

  if (redis && redisAvailable) {
    try {
      const result = await redis.eval(
        RELEASE_OWNED_LOCK_SCRIPT, 1, lock.key, lock.instanceId,
      ) as number;
      if (result === 1) {
        logger.debug({ instanceId: lock.instanceId }, "Released distributed scan lock");
      }
      return;
    } catch (err) {
      logger.warn(
        { errorName: err instanceof Error ? err.name : "UnknownError" },
        "Redis scan lock release failed",
      );
    }
  }

  inMemoryLocks.delete(SCAN_LOCK_KEY);
  logger.debug({ instanceId: lock.instanceId }, "Released in-memory scan lock");
}

export async function tryAcquireAdUpdateLock(
  adId: string,
  instanceId: string,
): Promise<DistributedLock> {
  const key = `${AD_UPDATE_LOCK_PREFIX}${adId}`;
  const lock: DistributedLock = { key, instanceId, released: false };

  if (redis && redisAvailable) {
    try {
      const acquired = await redis.set(key, instanceId, "EX", AD_UPDATE_LOCK_TTL_SEC, "NX");
      if (acquired === "OK") {
        logger.debug(
          { adId, instanceId, ttlSec: AD_UPDATE_LOCK_TTL_SEC },
          "Acquired distributed ad-update lock",
        );
        return lock;
      }
      const holder = await redis.get(key);
      logger.debug({ adId, instanceId, holder }, "Distributed ad-update lock already held");
      return lock;
    } catch (err) {
      logger.warn(
        { errorName: err instanceof Error ? err.name : "UnknownError", adId },
        "Redis ad-update lock acquisition failed; using in-memory",
      );
    }
  }

  if (inMemoryLocks.has(key)) {
    logger.debug({ adId, instanceId }, "In-memory ad-update lock already held");
    return lock;
  }
  inMemoryLocks.add(key);
  logger.debug(
    { adId, instanceId },
    "Acquired in-memory ad-update lock (single-instance mode)",
  );
  return lock;
}

export async function releaseAdUpdateLock(lock: DistributedLock): Promise<void> {
  if (lock.released) return;
  lock.released = true;

  if (redis && redisAvailable) {
    try {
      await redis.eval(
        RELEASE_OWNED_LOCK_SCRIPT, 1, lock.key, lock.instanceId,
      ) as number;
      logger.debug(
        { key: lock.key, instanceId: lock.instanceId },
        "Released distributed ad-update lock",
      );
      return;
    } catch (err) {
      logger.warn(
        { errorName: err instanceof Error ? err.name : "UnknownError", key: lock.key },
        "Redis ad-update lock release failed",
      );
    }
  }

  inMemoryLocks.delete(lock.key);
  logger.debug(
    { key: lock.key, instanceId: lock.instanceId },
    "Released in-memory ad-update lock",
  );
}
