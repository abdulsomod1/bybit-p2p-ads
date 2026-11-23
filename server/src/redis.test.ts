import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Test the Redis module with in-memory fallback (Redis unavailable)
vi.mock("ioredis", () => {
  class MockRedis {
    static status = "ready";
    options = { host: "localhost", port: 6379 };
    ping = vi.fn(async () => "PONG");
    get = vi.fn(async () => null);
    set = vi.fn(async () => "OK");
    hgetall = vi.fn(async () => ({}));
    hset = vi.fn(async () => 1);
    expire = vi.fn(async () => 1);
    ttl = vi.fn(async () => -1);
    multi = vi.fn(() => ({
      hset: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => []),
    }));
    eval = vi.fn(async () => [1, 1, -1] as [number, number, number]);
    quit = vi.fn(async () => "OK");
    on() { return this; }
    once() { return this; }
  }
  return { default: MockRedis };
});

vi.mock("./config.js", () => ({
  config: {
    redisEnabled: true,
    redisUrl: "redis://localhost:6379",
    redisMarketDataTtlSec: 5,
    bybitApiKey: "test-key",
    bybitApiSecret: "test-secret",
  },
}));

describe("Redis integration", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let redis: any;

  beforeEach(async () => {
    vi.resetModules();
    redis = await import("./redis.js");
  });

  // MARKET DATA CACHE
  it("getCachedMarketData returns null when no data cached", async () => {
    const result = await redis.getCachedMarketData("BTC", "NGN", "1");
    expect(result).toBeNull();
  });

  it("setCachedMarketData stores data for in-memory fallback", async () => {
    await redis.setCachedMarketData("BTC", "NGN", "1", [{ id: "ad-1", price: "600" }]);
    const cached = await redis.getCachedMarketData("BTC", "NGN", "1");
    expect(cached).not.toBeNull();
    expect(cached!.ads).toHaveLength(1);
  });

  it("cache separates different markets", async () => {
    await redis.setCachedMarketData("BTC", "NGN", "1", [{ id: "btc-sell" }]);
    await redis.setCachedMarketData("BTC", "NGN", "0", [{ id: "btc-buy" }]);
    await redis.setCachedMarketData("USDT", "NGN", "1", [{ id: "usdt-sell" }]);

    const btcSell = await redis.getCachedMarketData("BTC", "NGN", "1");
    const btcBuy = await redis.getCachedMarketData("BTC", "NGN", "0");
    const usdtSell = await redis.getCachedMarketData("USDT", "NGN", "1");

    expect((btcSell as { ads: { id: string }[] }).ads[0].id).toBe("btc-sell");
    expect((btcBuy as { ads: { id: string }[] }).ads[0].id).toBe("btc-buy");
    expect((usdtSell as { ads: { id: string }[] }).ads[0].id).toBe("usdt-sell");
  });

  // DISTRIBUTED RATE LIMITING
  it("checkDistributedRateLimit allows first request", async () => {
    const key = `p2p:ratelimit:ad:${Date.now()}:first`;
    const result = await redis.checkDistributedRateLimit(key, 5, 60);
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(1);
    expect(result.limit).toBe(5);
  });

  it("checkDistributedRateLimit blocks when limit reached", async () => {
    const key = `p2p:ratelimit:ad:${Date.now()}:block`;
    await redis.checkDistributedRateLimit(key, 1, 60);
    const blocked = await redis.checkDistributedRateLimit(key, 1, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("rate limit");
  });

  // DISTRIBUTED LOCKS
  it("tryAcquireScanLock returns a lock object", async () => {
    const lock = await redis.tryAcquireScanLock("instance-test-1");
    expect(lock.key).toBe("p2p:lock:scan");
    expect(lock.instanceId).toBe("instance-test-1");
    expect(lock.released).toBe(false);
  });

  it("releaseScanLock marks lock as released", async () => {
    const lock = await redis.tryAcquireScanLock("instance-test-2");
    await redis.releaseScanLock(lock);
    expect(lock.released).toBe(true);
  });

  it("releaseScanLock is idempotent", async () => {
    const lock = await redis.tryAcquireScanLock("instance-test-3");
    await redis.releaseScanLock(lock);
    await redis.releaseScanLock(lock);
    expect(lock.released).toBe(true);
  });

  it("tryAcquireAdUpdateLock returns lock with ad-specific key", async () => {
    const lock = await redis.tryAcquireAdUpdateLock("ad-12345", "instance-test-4");
    expect(lock.key).toBe("p2p:lock:ad:ad-12345");
    expect(lock.instanceId).toBe("instance-test-4");
  });

  it("releaseAdUpdateLock marks lock as released", async () => {
    const lock = await redis.tryAcquireAdUpdateLock("ad-67890", "instance-test-5");
    await redis.releaseAdUpdateLock(lock);
    expect(lock.released).toBe(true);
  });

  it("releaseAdUpdateLock is idempotent", async () => {
    const lock = await redis.tryAcquireAdUpdateLock("ad-abc", "instance-test-6");
    await redis.releaseAdUpdateLock(lock);
    await redis.releaseAdUpdateLock(lock);
    expect(lock.released).toBe(true);
  });

  it("closeRedis completes without error", async () => {
    await expect(redis.closeRedis()).resolves.toBeUndefined();
  });

  it("initRedis completes without error when configured", async () => {
    await expect(redis.initRedis()).resolves.toBeUndefined();
  });
});

// END_PART_B
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports serverInstanceId as a non-empty UUID", () => {
    expect(redis.serverInstanceId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("checkRedisHealth returns in_memory mode when Redis unavailable", async () => {
    const health = await redis.checkRedisHealth();
    expect(health.mode).toBe("in_memory");
    expect(health.connected).toBe(false);
  });

  // END_PART_A