import { beforeEach, describe, expect, it, vi } from "vitest";

const { bybitRequestMock } = vi.hoisted(() => ({
  bybitRequestMock: vi.fn(),
}));

vi.mock("./bybit.js", () => {
  class BybitRequestError extends Error {
    constructor(
      message: string,
      readonly options: {
        retryable: boolean;
        retCode?: number;
        httpStatus?: number;
        rateLimit?: { limit: number | null; remaining: number | null; resetAt: number | null };
      },
    ) {
      super(message);
      this.name = "BybitRequestError";
    }
  }

  return { BybitRequestError, bybitRequest: bybitRequestMock };
});

vi.mock("./config.js", () => ({
  config: { bybitApiKey: "test-key", bybitApiSecret: "test-secret" },
}));

import { BybitRequestError } from "./bybit.js";
import { fetchOwnAds, updateP2PAd, type P2PUpdatePayload } from "./p2p.js";

const successResponse = {
  retCode: 0,
  retMsg: "OK",
  result: { count: 0, items: [] },
  latencyMs: 1,
  rateLimit: { limit: 10, remaining: 9, resetAt: null },
};

const updatePayload: P2PUpdatePayload = {
  id: "123",
  priceType: "0",
  premium: "",
  price: "100",
  minAmount: "10",
  maxAmount: "1000",
  remark: "",
  tradingPreferenceSet: {},
  paymentIds: ["14"],
  actionType: "MODIFY",
  quantity: "1",
  paymentPeriod: "15",
};

describe("P2P request retry policy", () => {
  beforeEach(() => {
    bybitRequestMock.mockReset();
  });

  it.each([
    ["rate limit", { retryable: true, retCode: 10006 }],
    ["network timeout", { retryable: true }],
  ])("retries a transient read after a %s response", async (_label, options) => {
    bybitRequestMock
      .mockRejectedValueOnce(new BybitRequestError("temporary failure", options))
      .mockResolvedValueOnce(successResponse);

    await expect(fetchOwnAds("BTC", "0")).resolves.toEqual([]);
    expect(bybitRequestMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry authentication failures", async () => {
    bybitRequestMock.mockRejectedValue(
      new BybitRequestError("permission denied", { retryable: false, retCode: 10005 }),
    );

    await expect(fetchOwnAds("BTC", "0")).rejects.toThrow("permission denied");
    expect(bybitRequestMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry an advertisement update after an ambiguous failure", async () => {
    bybitRequestMock.mockRejectedValue(
      new BybitRequestError("request timed out", { retryable: true }),
    );

    await expect(updateP2PAd(updatePayload)).rejects.toThrow("request timed out");
    expect(bybitRequestMock).toHaveBeenCalledTimes(1);
  });

  it("backs off and retries an explicitly rate-limited update response", async () => {
    bybitRequestMock
      .mockRejectedValueOnce(new BybitRequestError("too many visits", {
        retryable: true,
        retCode: 10006,
      }))
      .mockResolvedValueOnce({
        ...successResponse,
        result: { needSecurityRisk: false },
      });

    await expect(updateP2PAd(updatePayload)).resolves.toMatchObject({ retCode: 0 });
    expect(bybitRequestMock).toHaveBeenCalledTimes(2);
  });
});
