import { beforeEach, describe, expect, it, vi } from "vitest";

const { clientQueryMock, releaseMock } = vi.hoisted(() => ({
  clientQueryMock: vi.fn(),
  releaseMock: vi.fn(),
}));

vi.mock("./db.js", () => ({
  pool: {
    connect: vi.fn(async () => ({
      query: clientQueryMock,
      release: releaseMock,
    })),
    query: vi.fn(),
  },
}));

vi.mock("./config.js", () => ({
  config: { p2pScanIntervalMs: 10_000 },
}));

import { resetP2PLiveModeAtStartup } from "./p2p-live.js";

describe("P2P live-mode restart safety", () => {
  beforeEach(() => {
    clientQueryMock.mockReset();
    releaseMock.mockReset();
    clientQueryMock.mockImplementation(async (query: string) => {
      if (query.includes("SELECT live_enabled")) {
        return {
          rows: [{ live_enabled: true, emergency_stopped: false, auto_repricing_enabled: true }],
        };
      }
      return { rows: [], rowCount: 1 };
    });
  });

  it("disarms LIVE and automatic repricing at startup", async () => {
    await resetP2PLiveModeAtStartup();

    const resetQuery = clientQueryMock.mock.calls.find(([query]) =>
      typeof query === "string" && query.includes("SET live_enabled = FALSE"),
    );
    expect(resetQuery?.[0]).toContain("auto_repricing_enabled = FALSE");
    expect(resetQuery?.[1]).toEqual([10_000]);
    expect(clientQueryMock).toHaveBeenCalledWith("COMMIT");
    expect(releaseMock).toHaveBeenCalledOnce();
  });
});
