export type ApiError = {
  error: { code: string; message: string };
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: { code: "REQUEST_FAILED", message: "Request failed" } })) as ApiError;
    throw new Error(body.error.message);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ user: { username: string; role: string } }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  me: () => request<{ user: { username: string; role: string } }>("/auth/me"),
  health: () => request<{ status: string; timestamp: string; database: string }>("/health"),
  status: () => request<{
    environment: string;
    databaseConfigured: boolean;
    bybitCredentialsConfigured: boolean;
    bybitTestnet: boolean;
    p2pAutoScanEnabled: boolean;
    p2pScanIntervalMs: number;
    p2pLargeChangeThresholdNgn: number;
  }>("/config/status"),
  p2pLiveStatus: () => request<P2PLiveStatus>("/p2p/live/status"),
  enableP2PLive: () => request<P2PLiveStatus>("/p2p/live/enable", { method: "POST" }),
  stopP2PLive: () => request<P2PLiveStatus>("/p2p/live/stop", { method: "POST" }),
  setAutomaticRepricing: (enabled: boolean, scanIntervalMs: number) =>
    request<P2PLiveStatus>("/p2p/live/automatic", {
      method: "POST",
      body: JSON.stringify({ enabled, scanIntervalMs }),
    }),
  saveAdRepricingSettings: (
    adId: string,
    settings: Omit<P2PAdRepricingSettings, "pricingParametersUpdatedAt" | "pauseReason">,
  ) => request<{ settings: P2PAdRepricingSettings }>(`/p2p/ads/${adId}/repricing`, {
    method: "POST",
    body: JSON.stringify(settings),
  }),
  p2pAutomationMetrics: () => request<P2PAutomationMetrics>("/p2p/automation/metrics"),
  applyP2PProposal: (proposalId: string) =>
    request<{ adId: string; updatedPrice: string; apiResponse: unknown }>(`/p2p/proposals/${proposalId}/apply`, {
      method: "POST",
    }),
  p2pAds: () => request<{ available: boolean; ads: OwnP2PAd[] }>("/p2p/ads"),
  serverTime: () => request<{ bybit: unknown }>("/bybit/server-time"),
  operations: () => request<{ operations: Operation[] }>("/operations"),
  p2pScan: () => request<{
    mode: "dry_run" | "live";
    automaticRepricingEnabled: boolean;
    scannedAt: string;
    largeChangeThresholdNgn: number;
    proposals: PriceProposal[];
  }>("/p2p/scan", {
    method: "POST",
    body: "{}",
  }),
  p2pProposals: () => request<{
    mode: "dry_run" | "live";
    automaticRepricingEnabled: boolean;
    proposals: PriceProposal[];
  }>("/p2p/proposals"),
  createOperation: (operationType: "bybit_server_time" | "stop_bot", idempotencyKey: string) =>
    request<{ operation: Operation }>("/operations", {
      method: "POST",
      body: JSON.stringify({ operationType, idempotencyKey }),
    }),
};

export type P2PLiveStatus = {
  mode: "dry_run" | "live";
  emergencyStopped: boolean;
  automaticRepricingEnabled: boolean;
  scanIntervalMs: number;
  permissionsVerifiedAt: string | null;
  minPriceNgn: string | null;
  maxPriceNgn: string | null;
  maxChangeNgn: string;
  limitsConfigured: boolean;
};

export type P2PAdRepricingSettings = {
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
  pricingParametersUpdatedAt: string | null;
  pauseReason: string | null;
};

export type P2PAutomationMetrics = {
  latestScan: {
    completedAt: string | null;
    durationMs: number;
    apiCallCount: number;
    averageApiLatencyMs: number;
    averageDurationMs: number;
    rateLimitWarnings: number;
  };
  updates: {
    updatedToday: number;
    failedToday: number;
    lastSuccessfulUpdateAt: string | null;
    averageUpdateDurationMs: number;
  };
};

export type PriceProposal = {
  id: string;
  scanId: string;
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
  createdAt: string;
  executionStatus: "dry_run" | "updated" | "skipped" | "failed" | "paused";
  executionMessage: string;
};

export type OwnP2PAd = {
  id: string;
  tokenId: string;
  currencyId: string;
  side: string;
  price: string;
  status: number;
  priceType: string;
  minAmount: string;
  maxAmount: string;
  repricing: P2PAdRepricingSettings | null;
};

export type Operation = {
  id: string;
  operation_type: string;
  status: string;
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
  created_by?: string;
  created_at: string;
  updated_at: string;
};
