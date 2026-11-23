import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  api,
  Operation,
  OwnP2PAd,
  P2PAdRepricingSettings,
  P2PAutomationMetrics,
  P2PLiveStatus,
  PriceProposal,
} from "./api";
import { createSecureUuid } from "./uuid";

type User = { username: string; role: string };
type ConfigStatus = {
  environment: string;
  databaseConfigured: boolean;
  bybitCredentialsConfigured: boolean;
  bybitTestnet: boolean;
  p2pAutoScanEnabled: boolean;
  p2pScanIntervalMs: number;
  p2pLargeChangeThresholdNgn: number;
};
type AdRepricingDraft = {
  enabled: boolean;
  referencePrice: string;
  minimumMarginPercent: string;
  competitiveOffsetNgn: string;
  minimumDifferenceNgn: string;
  minimumCompetitorLiquidityNgn: string;
  minRecentOrderNum: string;
  minRecentExecuteRate: string;
};

function createAdRepricingDraft(settings: P2PAdRepricingSettings | null): AdRepricingDraft {
  return {
    enabled: settings?.enabled ?? false,
    referencePrice: settings?.referencePrice ?? "",
    minimumMarginPercent: settings?.minimumMarginPercent ?? "",
    competitiveOffsetNgn: settings?.competitiveOffsetNgn ?? "1",
    minimumDifferenceNgn: settings?.minimumDifferenceNgn ?? "1",
    minimumCompetitorLiquidityNgn: settings?.minimumCompetitorLiquidityNgn ?? "0",
    minRecentOrderNum: String(settings?.minRecentOrderNum ?? 10),
    minRecentExecuteRate: settings?.minRecentExecuteRate ?? "80",
  };
}

function displayPrice(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [health, setHealth] = useState<{ status: string; database: string } | null>(null);
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [liveStatus, setLiveStatus] = useState<P2PLiveStatus | null>(null);
  const [automationMetrics, setAutomationMetrics] = useState<P2PAutomationMetrics | null>(null);
  const [scanIntervalDraft, setScanIntervalDraft] = useState(5_000);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [ownAds, setOwnAds] = useState<OwnP2PAd[]>([]);
  const [ownAdsAvailable, setOwnAdsAvailable] = useState(false);
  const [proposals, setProposals] = useState<PriceProposal[]>([]);
  const [adRepricingDrafts, setAdRepricingDrafts] = useState<Record<string, AdRepricingDraft>>({});
  const [busy, setBusy] = useState("");

  const setOwnAdsWithDrafts = useCallback((ads: OwnP2PAd[]) => {
    setOwnAds(ads);
    setAdRepricingDrafts((previous) => {
      const next: Record<string, AdRepricingDraft> = {};
      for (const ad of ads) next[ad.id] = previous[ad.id] ?? createAdRepricingDraft(ad.repricing);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      api.health(),
      api.status(),
      api.operations(),
      api.p2pProposals(),
      api.p2pLiveStatus(),
      api.p2pAds(),
      api.p2pAutomationMetrics(),
    ]);
    if (results[0].status === "fulfilled") setHealth(results[0].value);
    if (results[1].status === "fulfilled") setStatus(results[1].value);
    if (results[2].status === "fulfilled") setOperations(results[2].value.operations);
    if (results[3].status === "fulfilled") setProposals(results[3].value.proposals);
    if (results[4].status === "fulfilled") {
      setLiveStatus(results[4].value);
      setScanIntervalDraft(results[4].value.scanIntervalMs);
    }
    if (results[5].status === "fulfilled") {
      setOwnAdsAvailable(results[5].value.available);
      setOwnAdsWithDrafts(results[5].value.ads);
    }
    if (results[6].status === "fulfilled") setAutomationMetrics(results[6].value);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason instanceof Error ? failure.reason : new Error("Unable to load dashboard");
    }
  }, [setOwnAdsWithDrafts]);

  useEffect(() => {
    api.me()
      .then(async (result) => {
        setUser(result.user);
        await refresh();
      })
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, [refresh]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => {
      Promise.all([api.p2pProposals(), api.p2pLiveStatus(), api.p2pAutomationMetrics()])
        .then(([proposalResult, liveResult, metricsResult]) => {
          setProposals(proposalResult.proposals);
          setLiveStatus(liveResult);
          setAutomationMetrics(metricsResult);
        })
        .catch((reason: unknown) => setError(
          reason instanceof Error ? reason.message : "Unable to refresh repricing status",
        ));
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [user]);

  async function login(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy("login");
    try {
      const result = await api.login(username, password);
      setUser(result.user);
      setPassword("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Login failed");
    } finally {
      setBusy("");
    }
  }

  async function logout() {
    setError("");
    try {
      await api.logout();
      setUser(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Logout failed");
    }
  }

  async function probe() {
    setError("");
    setBusy("probe");
    try {
      await api.serverTime();
      await api.createOperation("bybit_server_time", createSecureUuid());
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Bybit probe failed");
    } finally {
      setBusy("");
    }
  }

  async function scanP2P() {
    setError("");
    setBusy("scan");
    try {
      const result = await api.p2pScan();
      setProposals(result.proposals);
      const currentAds = await api.p2pAds();
      setOwnAdsAvailable(currentAds.available);
      setOwnAdsWithDrafts(currentAds.ads);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "P2P market scan failed");
    } finally {
      setBusy("");
    }
  }

  async function enableLiveMode() {
    if (!window.confirm("Enable LIVE advertisement updates? This can change your public Bybit P2P ads. Orders and payments will still require manual handling.")) return;
    setError("");
    setBusy("live-enable");
    try {
      setLiveStatus(await api.enableP2PLive());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to enable live updates");
    } finally {
      setBusy("");
    }
  }

  async function setAutomaticRepricing(enabled: boolean) {
    if (enabled && !window.confirm(
      "Enable AUTOMATIC LIVE repricing for the advertisements you have individually enabled? " +
      "Valid price changes will be submitted without per-change confirmation.",
    )) return;
    setError("");
    setBusy("auto");
    try {
      const result = await api.setAutomaticRepricing(enabled, scanIntervalDraft);
      setLiveStatus(result);
      setScanIntervalDraft(result.scanIntervalMs);
      setAutomationMetrics(await api.p2pAutomationMetrics());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to change automatic repricing");
    } finally {
      setBusy("");
    }
  }

  async function saveAdRepricingSettings(ad: OwnP2PAd) {
    const draft = adRepricingDrafts[ad.id];
    if (!draft) return;
    setError("");
    setBusy(`settings:${ad.id}`);
    try {
      const result = await api.saveAdRepricingSettings(ad.id, {
        adId: ad.id,
        tokenId: ad.tokenId as "BTC" | "USDT",
        currencyId: "NGN",
        side: ad.side as "0" | "1",
        enabled: draft.enabled,
        referencePrice: draft.referencePrice.trim() || null,
        minimumMarginPercent: draft.minimumMarginPercent.trim() || null,
        competitiveOffsetNgn: draft.competitiveOffsetNgn,
        minimumDifferenceNgn: draft.minimumDifferenceNgn,
        minimumCompetitorLiquidityNgn: draft.minimumCompetitorLiquidityNgn,
        minRecentOrderNum: Number(draft.minRecentOrderNum),
        minRecentExecuteRate: draft.minRecentExecuteRate,
      });
      setAdRepricingDrafts((previous) => ({
        ...previous,
        [ad.id]: createAdRepricingDraft(result.settings),
      }));
      setOwnAds((previous) => previous.map((item) =>
        item.id === ad.id ? { ...item, repricing: result.settings } : item,
      ));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save advertisement settings");
    } finally {
      setBusy("");
    }
  }

  function updateAdDraft(adId: string, field: keyof AdRepricingDraft, value: string | boolean) {
    setAdRepricingDrafts((previous) => ({
      ...previous,
      [adId]: { ...previous[adId], [field]: value },
    }));
  }

  async function emergencyStop() {
    setError("");
    setBusy("live-stop");
    try {
      setLiveStatus(await api.stopP2PLive());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Emergency STOP could not be confirmed");
    } finally {
      setBusy("");
    }
  }

  async function refreshOwnAds() {
    setError("");
    setBusy("ads");
    try {
      const result = await api.p2pAds();
      setOwnAdsAvailable(result.available);
      setOwnAdsWithDrafts(result.ads);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to retrieve your Bybit advertisements");
    } finally {
      setBusy("");
    }
  }

  if (checking) return <main className="center"><div className="spinner" /><p>Checking session...</p></main>;

  if (!user) {
    return (
      <main className="login-shell">
        <form className="login-card" onSubmit={login}>
          <div className="brand-mark">B</div>
          <p className="eyebrow">Secure operations</p>
          <h1>Bybit P2P Bot</h1>
          {error && <div className="alert error" role="alert">{error}</div>}
          <label>Username<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required /></label>
          <button className="primary" disabled={busy === "login"}>{busy === "login" ? "Signing in..." : "Sign in"}</button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside>
        <div className="brand"><div className="brand-mark">B</div><strong>Bybit P2P</strong></div>
        <nav><button className="active">Overview</button></nav>
        <button className="logout" onClick={logout}>Sign out</button>
      </aside>
      <main>
        <header>
          <div><p className="eyebrow">Operations</p><h1>Overview</h1></div>
          <div className={`pill ${health?.status === "healthy" ? "success" : "warning"}`}>{health?.status ?? "Checking"}</div>
        </header>
        {error && <div className="alert error" role="alert">{error}</div>}
        <section className="metrics">
          <article><span>Environment</span><strong>{status?.environment ?? "-"}</strong></article>
          <article><span>Database</span><strong>{status?.databaseConfigured ? "Configured" : "Missing"}</strong></article>
          <article><span>Bybit API</span><strong>{status?.bybitCredentialsConfigured ? (status.bybitTestnet ? "Testnet" : "Mainnet") : "Not configured"}</strong></article>
          <article><span>Operations</span><strong>{operations.length}</strong></article>
          <article><span>Average scan</span><strong>{automationMetrics?.latestScan.averageDurationMs ?? 0} ms</strong></article>
          <article><span>Average update</span><strong>{automationMetrics?.updates.averageUpdateDurationMs ?? 0} ms</strong></article>
          <article><span>Current scan interval</span><strong>{Math.round((liveStatus?.scanIntervalMs ?? status?.p2pScanIntervalMs ?? 5_000) / 1000)} sec</strong></article>
          <article><span>Bybit API latency</span><strong>{automationMetrics?.latestScan.averageApiLatencyMs ?? 0} ms</strong></article>
          <article><span>Updates today</span><strong>{automationMetrics?.updates.updatedToday ?? 0}</strong></article>
          <article><span>Update failures</span><strong>{automationMetrics?.updates.failedToday ?? 0}</strong></article>
          <article><span>Rate-limit warnings</span><strong>{automationMetrics?.latestScan.rateLimitWarnings ?? 0}</strong></article>
          <article><span>Last confirmed update</span><strong>{automationMetrics?.updates.lastSuccessfulUpdateAt
            ? new Date(automationMetrics.updates.lastSuccessfulUpdateAt).toLocaleTimeString()
            : "None"}</strong></article>
        </section>
        <section className="panel">
          <div className="panel-head"><div><p className="eyebrow">Connectivity</p><h2>Bybit connection</h2></div><button className="primary" onClick={probe} disabled={busy === "probe"}>{busy === "probe" ? "Testing..." : "Test public API"}</button></div>
          <p>{status?.bybitCredentialsConfigured ? "Private credentials are configured. Money-moving actions must use explicit approval." : "No private credentials configured. Public connectivity testing is available."}</p>
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Advertisement repricing</p>
              <h2>{liveStatus?.mode === "live" ? "LIVE mode enabled" : "DRY-RUN mode"}</h2>
            </div>
            <div className="panel-head">
              <button
                className="primary"
                onClick={enableLiveMode}
                disabled={
                  busy !== ""
                  || liveStatus?.mode === "live"
                  || !status?.databaseConfigured
                  || !status?.bybitCredentialsConfigured
                  || !liveStatus?.limitsConfigured
                }
              >
                {busy === "live-enable" ? "Verifying permissions..." : "Enable LIVE"}
              </button>
              <button
                className={liveStatus?.automaticRepricingEnabled ? "danger" : "primary"}
                onClick={() => setAutomaticRepricing(!liveStatus?.automaticRepricingEnabled)}
                disabled={
                  busy !== ""
                  || !status?.databaseConfigured
                  || !status?.bybitCredentialsConfigured
                  || !liveStatus?.limitsConfigured
                  || liveStatus?.mode !== "live"
                  || liveStatus?.emergencyStopped
                }
              >
                {busy === "auto"
                  ? "Verifying..."
                  : liveStatus?.automaticRepricingEnabled
                    ? "Disable Auto"
                    : "Enable Auto"}
              </button>
              <button className="danger" onClick={emergencyStop} disabled={busy !== "" || liveStatus?.emergencyStopped}>
                {busy === "live-stop" ? "Stopping..." : liveStatus?.emergencyStopped ? "STOP ACTIVE" : "EMERGENCY STOP"}
              </button>
            </div>
          </div>
          <p>
            {liveStatus?.mode === "live" && !liveStatus.emergencyStopped
              ? liveStatus.automaticRepricingEnabled
                ? "Automatic repricing is ON for individually enabled, configured advertisements. Every update is checked against live limits."
                : "LIVE is armed, but automatic repricing is OFF. No ad changes happen until Auto is explicitly enabled."
              : "DRY-RUN is the default after every restart. No advertisement changes are sent until an admin enables LIVE."}
            {" "}Payments, order completion, asset release, withdrawals, and transfers are not automated.
          </p>
          <div className="settings-row">
            <label>
              Scan interval (seconds)
              <input
                type="number"
                min={5}
                max={300}
                step={1}
                value={scanIntervalDraft / 1000}
                onChange={(event) => setScanIntervalDraft(Number(event.target.value) * 1000)}
              />
            </label>
            <button
              className="secondary"
              onClick={() => setAutomaticRepricing(Boolean(liveStatus?.automaticRepricingEnabled))}
              disabled={busy !== "" || !liveStatus?.limitsConfigured}
            >
              Save interval
            </button>
            <span>Minimum 5 seconds; scheduler never overlaps scans.</span>
          </div>
          <p>
            Live price range: {liveStatus?.limitsConfigured
              ? `₦${liveStatus.minPriceNgn}–₦${liveStatus.maxPriceNgn}; maximum change ₦${liveStatus.maxChangeNgn}`
              : "not configured. Set P2P_LIVE_MIN_PRICE_NGN and P2P_LIVE_MAX_PRICE_NGN in the server environment."}
          </p>
          {liveStatus?.permissionsVerifiedAt && (
            <p>Bybit Advertising permission last verified: {new Date(liveStatus.permissionsVerifiedAt).toLocaleString()}. It is checked again before each update.</p>
          )}
          {status?.bybitTestnet === false && (
            <div className="alert warning" role="status">Configured for Bybit mainnet. LIVE updates affect public advertisements.</div>
          )}
        </section>
        <section className="panel">
          <div className="panel-head">
            <div><p className="eyebrow">Bybit account</p><h2>My advertisements</h2></div>
            <button className="primary" onClick={refreshOwnAds} disabled={busy !== "" || !status?.bybitCredentialsConfigured}>
              {busy === "ads" ? "Refreshing..." : "Refresh ads"}
            </button>
          </div>
          {!ownAdsAvailable
            ? <p className="empty">Configure Bybit P2P API credentials to retrieve your advertisements.</p>
            : ownAds.length === 0
              ? <p className="empty">No advertisements were returned for BTC/NGN or USDT/NGN.</p>
              : (
                <div className="table-wrap">
                  <table>
                    <thead><tr>
                      <th>Ad / market</th><th>Side / current</th><th>Min / max amount</th><th>Status</th>
                      <th>Auto</th><th>Reference price</th><th>Min margin %</th><th>Offset</th>
                      <th>Min difference</th><th>Min liquidity</th><th>Min orders</th>
                      <th>Min completion %</th><th>Settings</th>
                    </tr></thead>
                    <tbody>
                      {ownAds.map((ad) => (
                        <tr key={ad.id}>
                          <td><strong>{ad.id}</strong><br />{ad.tokenId}/{ad.currencyId}</td>
                          <td>{ad.side === "0" ? "Buy" : "Sell"}<br />₦{displayPrice(ad.price)}</td>
                          <td>₦{displayPrice(ad.minAmount)} / ₦{displayPrice(ad.maxAmount)}</td>
                          <td>
                            {ad.status === 10 ? "Online" : ad.status === 20 ? "Offline" : "Completed"}
                            {ad.repricing?.pauseReason && <><br /><span className="status warning-text">Paused: {ad.repricing.pauseReason}</span></>}
                            {ad.repricing?.pricingParametersUpdatedAt && (
                              <><br /><small>Inputs confirmed {new Date(ad.repricing.pricingParametersUpdatedAt).toLocaleDateString()}</small></>
                            )}
                          </td>
                          <td>
                            <input
                              aria-label={`Enable automatic repricing for ${ad.id}`}
                              type="checkbox"
                              checked={adRepricingDrafts[ad.id]?.enabled ?? false}
                              onChange={(event) => updateAdDraft(ad.id, "enabled", event.target.checked)}
                            />
                          </td>
                          <td><input aria-label={`Reference price for ${ad.id}`} type="number" min="0" step="0.00000001" value={adRepricingDrafts[ad.id]?.referencePrice ?? ""} onChange={(event) => updateAdDraft(ad.id, "referencePrice", event.target.value)} /></td>
                          <td><input aria-label={`Minimum margin for ${ad.id}`} type="number" min="0" max="100" step="0.01" value={adRepricingDrafts[ad.id]?.minimumMarginPercent ?? ""} onChange={(event) => updateAdDraft(ad.id, "minimumMarginPercent", event.target.value)} /></td>
                          <td><input aria-label={`Competitive offset for ${ad.id}`} type="number" min="0" step="0.01" value={adRepricingDrafts[ad.id]?.competitiveOffsetNgn ?? "1"} onChange={(event) => updateAdDraft(ad.id, "competitiveOffsetNgn", event.target.value)} /></td>
                          <td><input aria-label={`Minimum difference for ${ad.id}`} type="number" min="0.01" step="0.01" value={adRepricingDrafts[ad.id]?.minimumDifferenceNgn ?? "1"} onChange={(event) => updateAdDraft(ad.id, "minimumDifferenceNgn", event.target.value)} /></td>
                          <td><input aria-label={`Minimum liquidity for ${ad.id}`} type="number" min="0" step="1" value={adRepricingDrafts[ad.id]?.minimumCompetitorLiquidityNgn ?? "0"} onChange={(event) => updateAdDraft(ad.id, "minimumCompetitorLiquidityNgn", event.target.value)} /></td>
                          <td><input aria-label={`Minimum recent orders for ${ad.id}`} type="number" min="0" step="1" value={adRepricingDrafts[ad.id]?.minRecentOrderNum ?? "10"} onChange={(event) => updateAdDraft(ad.id, "minRecentOrderNum", event.target.value)} /></td>
                          <td><input aria-label={`Minimum completion rate for ${ad.id}`} type="number" min="0" max="100" step="0.01" value={adRepricingDrafts[ad.id]?.minRecentExecuteRate ?? "80"} onChange={(event) => updateAdDraft(ad.id, "minRecentExecuteRate", event.target.value)} /></td>
                          <td>
                            <button className="secondary" onClick={() => saveAdRepricingSettings(ad)} disabled={busy !== "" || ad.status !== 10 || ad.priceType !== "0"}>
                              {busy === `settings:${ad.id}` ? "Saving..." : "Save"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          <p>Enter a reference price per advertised token (for example, USDT for a USDT ad), including applicable fees. SELL minimum = reference × (1 + margin%); BUY maximum = reference × (1 − margin%). Saving is explicit; reference values are never inferred from market prices.</p>
        </section>
        <section className="panel">
          <div className="panel-head">
            <div><p className="eyebrow">BTC/NGN and USDT/NGN</p><h2>P2P ad price preview</h2></div>
            <button className="primary" onClick={scanP2P} disabled={busy === "scan" || !status?.bybitCredentialsConfigured || !status.databaseConfigured}>
              {busy === "scan" ? "Scanning..." : "Scan market"}
            </button>
          </div>
          <p>
            {liveStatus?.automaticRepricingEnabled
              ? "Automatically enabled ads are repriced when a valid target passes their individual safety limits."
              : "Market scans are read-only; no ad changes are made until LIVE and automatic repricing are explicitly enabled."}
            {" "}{status?.p2pAutoScanEnabled ? `Automatic scans run every ${Math.round((liveStatus?.scanIntervalMs ?? status.p2pScanIntervalMs ?? 5_000) / 1000)} seconds.` : "Automatic scans are disabled."}
            {" "}The target is the first returned Verified Advertiser (VA) ad that matches one of your ad's payment types; Bybit does not document the result ordering as a ranking guarantee.
          </p>
          <p>Changes greater than ₦{status?.p2pLargeChangeThresholdNgn ?? 600} are flagged. Large changes also generate a server warning.</p>
          {proposals.some((proposal) => proposal.largeChange) && (
            <div className="alert warning" role="status">
              Large proposed price change detected. Review the exact price below; no live update was made.
            </div>
          )}
          {proposals.length === 0 ? <p className="empty">No price changes proposed yet. A proposal requires an online own ad and a matching verified competitor payment method.</p> : (
            <div className="table-wrap">
              <table>
                <thead><tr>
                  <th>Market / side</th><th>Own price</th><th>Competitor</th><th>Target price</th>
                  <th>Profit / token</th><th>Projected margin</th><th>Required floor / ceiling</th>
                  <th>Change</th><th>Execution</th>
                </tr></thead>
                <tbody>
                  {proposals.map((proposal) => (
                    <tr key={proposal.id}>
                      <td>{proposal.tokenId}/{proposal.currencyId}<br />{proposal.side === "0" ? "Buy" : "Sell"}</td>
                      <td>₦{displayPrice(proposal.currentPrice)}</td>
                      <td>{proposal.competitorNickname || proposal.competitorAdId}<br />{proposal.competitorAdId}</td>
                      <td><strong>₦{displayPrice(proposal.proposedPrice)}</strong></td>
                      <td>₦{displayPrice(proposal.estimatedProfitPerToken)}</td>
                      <td>{displayPrice(proposal.projectedMarginPercent)}%</td>
                      <td>₦{displayPrice(proposal.minimumProfitablePrice)}</td>
                      <td>₦{displayPrice(proposal.priceDeltaNgn)}{proposal.largeChange && <><br /><span className="status warning-text">Large change</span></>}</td>
                      <td><span className={`status ${proposal.executionStatus === "updated" ? "success-text" : proposal.executionStatus === "failed" || proposal.executionStatus === "paused" ? "warning-text" : ""}`}>
                        {proposal.executionStatus === "updated" ? "Bybit confirmed" : proposal.executionStatus.toUpperCase()}
                      </span><br /><small>{proposal.executionMessage}</small></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="panel">
          <div className="panel-head"><div><p className="eyebrow">Audit trail</p><h2>Recent operations</h2></div></div>
          {operations.length === 0 ? <p className="empty">No operations have been created.</p> : (
            <div className="table-wrap"><table><thead><tr><th>Type</th><th>Status</th><th>Created by</th><th>Created</th></tr></thead><tbody>
              {operations.map((operation) => <tr key={operation.id}><td>{operation.operation_type}</td><td><span className="status">{operation.status}</span></td><td>{operation.created_by ?? "-"}</td><td>{new Date(operation.created_at).toLocaleString()}</td></tr>)}
            </tbody></table></div>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
