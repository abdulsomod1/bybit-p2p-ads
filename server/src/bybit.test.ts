import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { bybitRequest, createBybitSignature } from "./bybit.js";
import { config } from "./config.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Bybit integration", () => {
  it("exports a signed request function", () => {
    expect(typeof bybitRequest).toBe("function");
  });

  it("signs the exact V5 payload string with HMAC-SHA256", () => {
    const expected = crypto
      .createHmac("sha256", "test-secret")
      .update("1658384314791test-key5000{\"tokenId\":\"BTC\"}")
      .digest("hex");
    expect(createBybitSignature("test-key", "test-secret", "1658384314791", "5000", "{\"tokenId\":\"BTC\"}"))
      .toBe(expected);
  });

  it("signs authenticated requests with the configured API key and receive window", async () => {
    vi.stubEnv("BYBIT_API_KEY", "test-key");
    vi.stubEnv("BYBIT_API_SECRET", "test-secret");
    vi.stubEnv("BYBIT_BASE_URL", "https://configured-bybit.example");
    vi.resetModules();
    let requestUrl = "";
    let requestHeaders: Headers | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = input.toString();
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({
        retCode: 0,
        retMsg: "OK",
        result: { time: "123" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const { bybitRequest: configuredRequest } = await import("./bybit.js");

    await configuredRequest("GET", "/v5/market/time");

    expect(new URL(requestUrl).hostname).toBe("configured-bybit.example");
    expect(requestHeaders?.get("X-BAPI-API-KEY")).toBe("test-key");
    expect(requestHeaders?.get("X-BAPI-RECV-WINDOW")).toBe("5000");
    expect(requestHeaders?.get("X-BAPI-TIMESTAMP")).toMatch(/^\d+$/);
    expect(requestHeaders?.get("X-BAPI-SIGN")).toBe(createBybitSignature(
      "test-key",
      "test-secret",
      requestHeaders?.get("X-BAPI-TIMESTAMP") ?? "",
      "5000",
      "",
    ));
  });

  it("normalizes the P2P snake_case response envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ret_code: 0,
      ret_msg: "SUCCESS",
      result: { count: 0, items: [] },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(bybitRequest("POST", "/v5/p2p/item/online", {})).resolves.toMatchObject({
      retCode: 0,
      retMsg: "SUCCESS",
      result: { count: 0, items: [] },
      rateLimit: { limit: null, remaining: null, resetAt: null },
    });
  });

  it("explains aborted requests as a Bybit connection timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("This operation was aborted", "AbortError");
    }));

    await expect(bybitRequest("GET", "/v5/market/time", {}, 1_234))
      .rejects.toThrow(`Bybit request to ${new URL(config.bybitBaseUrl).host} timed out after 1234 ms`);
  });

  it("explains DNS and connection errors without exposing request details", async () => {
    const cause = Object.assign(new Error("DNS lookup failed"), { code: "ENOTFOUND" });
    const error = Object.assign(new TypeError("fetch failed"), { cause });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw error;
    }));

    await expect(bybitRequest("GET", "/v5/market/time"))
      .rejects.toThrow(`Could not connect to Bybit at ${new URL(config.bybitBaseUrl).host}`);
  });

  it("sends requests to the hostname configured by BYBIT_BASE_URL", async () => {
    vi.stubEnv("BYBIT_BASE_URL", "https://configured-bybit.example");
    vi.resetModules();
    let requestedUrl = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify({
        retCode: 0,
        retMsg: "OK",
        result: { time: "123" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const { bybitRequest: requestWithConfiguredHost } = await import("./bybit.js");

    await requestWithConfiguredHost("GET", "/v5/market/time");

    expect(new URL(requestedUrl).hostname).toBe("configured-bybit.example");
  });
});
