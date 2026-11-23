import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { config, validateProductionConfig } from "./config.js";
import { logger } from "./logger.js";
import { migrate, pool } from "./db.js";
import { bybitRequest } from "./bybit.js";
import { issueToken, requireAuth, requireRole } from "./auth.js";
import {
  clearAutomaticRepricingPause,
  configureAutomaticProposalHandler,
  getRecentP2PProposals,
  pauseAutomaticRepricingForRuntimeFailure,
  scanAndStoreP2PProposals,
  startP2PScanner,
} from "./p2p-monitor.js";
import { fetchP2POwnAds } from "./p2p.js";
import {
  applyP2PPriceProposal,
  enableP2PLiveMode,
  getP2PLiveStatus,
  getP2PAutomationMetrics,
  listP2PAdRepricingSettings,
  P2PLiveError,
  resetP2PLiveModeAtStartup,
  saveP2PAdRepricingSettings,
  setP2PAutomaticRepricing,
  stopP2PLiveMode,
} from "./p2p-live.js";
import {
  initRedis,
  closeRedis,
  checkRedisHealth,
  tryAcquireScanLock,
  releaseScanLock,
} from "./redis.js";

validateProductionConfig();

const app = express();
app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({
  origin: config.clientOrigin,
  credentials: true,
  methods: ["GET", "POST", "DELETE"],
}));
app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  req.requestId = req.headers["x-request-id"]?.toString() ?? crypto.randomUUID();
  res.setHeader("x-request-id", req.requestId);
  const started = Date.now();
  res.once("finish", () => {
    logger.info({
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - started,
    }, "Request completed");
  });
  next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

const p2pScanLimiter = rateLimit({
  windowMs: 15 * 1000,
  limit: 1,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

const p2pLiveUpdateLimiter = rateLimit({
  windowMs: 5_000,
  limit: 1,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

const adminPasswordHash = config.adminPassword
  ? bcrypt.hashSync(config.adminPassword, 12)
  : "";
const invalidPasswordHash = bcrypt.hashSync("invalid-password-padding", 12);
const serverInstanceId = crypto.randomUUID();

app.get("/api/health", async (_req, res) => {
  let database = "disconnected";
  try {
    await pool.query("SELECT 1");
    database = "connected";
  } catch {
    database = "disconnected";
  }
  const redisHealth = await checkRedisHealth();
  const overall = database === "connected" ? "healthy" : "degraded";
  res.status(overall === "healthy" ? 200 : 503).json({
    status: overall,
    timestamp: new Date().toISOString(),
    database,
    redis: {
      connected: redisHealth.connected,
      latencyMs: redisHealth.latencyMs,
      mode: redisHealth.mode,
    },
  });
});

app.post("/api/auth/login", loginLimiter, async (req, res) => {
  const schema = z.object({
    username: z.string().trim().min(1).max(100),
    password: z.string().min(8).max(256),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid credentials" } });
    return;
  }
  if (parsed.data.username !== config.adminUsername) {
    await bcrypt.compare(parsed.data.password, invalidPasswordHash);
    res.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid username or password" } });
    return;
  }
  if (!adminPasswordHash) {
    res.status(503).json({ error: { code: "NOT_CONFIGURED", message: "Admin password is not configured" } });
    return;
  }
  const valid = await bcrypt.compare(parsed.data.password, adminPasswordHash);
  if (!valid) {
    res.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid username or password" } });
    return;
  }
  const token = issueToken({ username: parsed.data.username, role: "admin" });
  res.cookie("session", token, {
    httpOnly: true,
    secure: config.secureCookie,
    sameSite: "strict",
    maxAge: 8 * 60 * 60 * 1000,
  });
  res.json({ user: { username: parsed.data.username, role: "admin" } });
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("session", { httpOnly: true, secure: config.secureCookie, sameSite: "strict" });
  res.status(204).send();
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.authUser });
});

app.get("/api/config/status", requireAuth, (_req, res) => {
  res.json({
    environment: config.nodeEnv,
    databaseConfigured: Boolean(config.databaseUrl),
    bybitCredentialsConfigured: Boolean(config.bybitApiKey && config.bybitApiSecret),
    bybitTestnet: config.bybitTestnet,
    p2pAutoScanEnabled: config.p2pAutoScanEnabled
      && Boolean(config.databaseUrl && config.bybitApiKey && config.bybitApiSecret),
    p2pScanIntervalMs: config.p2pScanIntervalMs,
    p2pLargeChangeThresholdNgn: config.p2pLargeChangeThresholdNgn,
  });
});

app.get("/api/p2p/live/status", requireAuth, requireRole("admin"), async (_req, res) => {
  try {
    res.json(await getP2PLiveStatus());
  } catch (error) {
    logger.error({
      errorName: error instanceof Error ? error.name : "UnknownError",
    }, "P2P live status lookup failed");
    res.status(503).json({
      error: { code: "LIVE_STATUS_UNAVAILABLE", message: "P2P live controls are unavailable" },
    });
  }
});

app.post("/api/p2p/live/enable", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    res.json(await enableP2PLiveMode(req.authUser!.username, req.requestId));
  } catch (error) {
    if (error instanceof P2PLiveError) {
      res.status(error.statusCode).json({ error: { code: "LIVE_MODE_NOT_ENABLED", message: error.message } });
      return;
    }
    logger.error({
      requestId: req.requestId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    }, "P2P live-mode enable failed");
    res.status(503).json({
      error: { code: "LIVE_MODE_NOT_ENABLED", message: "Permission verification or audit logging failed; live mode remains disabled" },
    });
  }
});

app.post("/api/p2p/live/stop", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    res.json(await stopP2PLiveMode(req.authUser!.username, req.requestId));
  } catch (error) {
    logger.error({
      requestId: req.requestId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    }, "P2P emergency STOP could not be persisted");
    res.status(503).json({
      error: { code: "EMERGENCY_STOP_UNAVAILABLE", message: "Emergency STOP could not be confirmed by the database" },
    });
  }
});

app.post("/api/p2p/live/automatic", requireAuth, requireRole("admin"), async (req, res) => {
  const parsed = z.object({
    enabled: z.boolean(),
    scanIntervalMs: z.number().int().min(5_000).max(300_000),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Invalid automatic repricing settings" },
    });
    return;
  }
  try {
    const status = await setP2PAutomaticRepricing(
      req.authUser!.username,
      parsed.data.enabled,
      parsed.data.scanIntervalMs,
      req.requestId,
    );
    if (parsed.data.enabled) clearAutomaticRepricingPause();
    res.json(status);
  } catch (error) {
    if (error instanceof P2PLiveError) {
      res.status(error.statusCode).json({ error: { code: "AUTO_REPRICING_NOT_CHANGED", message: error.message } });
      return;
    }
    logger.error({
      requestId: req.requestId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    }, "Automatic repricing setting failed");
    res.status(503).json({
      error: { code: "AUTO_REPRICING_NOT_CHANGED", message: "Automatic repricing could not be changed" },
    });
  }
});

app.get("/api/p2p/automation/metrics", requireAuth, requireRole("admin"), async (_req, res) => {
  try {
    res.json(await getP2PAutomationMetrics());
  } catch (error) {
    logger.error({
      errorName: error instanceof Error ? error.name : "UnknownError",
    }, "P2P repricing metrics lookup failed");
    res.status(503).json({
      error: { code: "METRICS_UNAVAILABLE", message: "P2P repricing metrics are unavailable" },
    });
  }
});

app.post("/api/p2p/ads/:adId/repricing", requireAuth, requireRole("admin"), async (req, res) => {
  const parsedId = z.string().regex(/^\d{1,32}$/).safeParse(req.params.adId);
  const parsedBody = z.object({
    tokenId: z.enum(["BTC", "USDT"]),
    currencyId: z.literal("NGN"),
    side: z.enum(["0", "1"]),
    enabled: z.boolean(),
    referencePrice: z.string().trim().min(1).max(40).nullable(),
    minimumMarginPercent: z.string().trim().min(1).max(16).nullable(),
    competitiveOffsetNgn: z.string().trim().min(1).max(40),
    minimumDifferenceNgn: z.string().trim().min(1).max(40),
    minimumCompetitorLiquidityNgn: z.string().trim().min(1).max(40),
    minRecentOrderNum: z.number().int().min(0).max(1_000_000),
    minRecentExecuteRate: z.string().trim().min(1).max(8),
  }).safeParse(req.body);
  if (!parsedId.success || !parsedBody.success) {
    res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Invalid advertisement repricing settings" },
    });
    return;
  }
  try {
    const settings = await saveP2PAdRepricingSettings(
      req.authUser!.username,
      { ...parsedBody.data, adId: parsedId.data },
      req.requestId,
    );
    res.json({ settings });
  } catch (error) {
    if (error instanceof P2PLiveError) {
      res.status(error.statusCode).json({ error: { code: "AD_REPRICING_NOT_SAVED", message: error.message } });
      return;
    }
    logger.error({
      requestId: req.requestId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    }, "Advertisement repricing settings save failed");
    res.status(503).json({
      error: { code: "AD_REPRICING_NOT_SAVED", message: "Advertisement repricing settings could not be saved" },
    });
  }
});

app.post(
  "/api/p2p/proposals/:proposalId/apply",
  requireAuth,
  requireRole("admin"),
  p2pLiveUpdateLimiter,
  async (req, res) => {
    const parsedId = z.string().uuid().safeParse(req.params.proposalId);
    if (!parsedId.success) {
      res.status(400).json({ error: { code: "INVALID_PROPOSAL_ID", message: "A valid stored proposal ID is required" } });
      return;
    }
    try {
      res.json(await applyP2PPriceProposal(
        parsedId.data,
        req.authUser!.username,
        req.requestId,
      ));
    } catch (error) {
      if (error instanceof P2PLiveError) {
        res.status(error.statusCode).json({ error: { code: "LIVE_UPDATE_REJECTED", message: error.message } });
        return;
      }
      logger.error({
        requestId: req.requestId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }, "P2P live update failed");
      res.status(503).json({
        error: {
          code: "LIVE_UPDATE_FAILED",
          message: "The update did not complete cleanly. Inspect the audit log and Bybit ad before retrying.",
        },
      });
    }
  },
);

app.get("/api/p2p/ads", requireAuth, requireRole("admin"), async (_req, res) => {
  if (!config.bybitApiKey || !config.bybitApiSecret) {
    res.json({ available: false, ads: [] });
    return;
  }
  try {
    const ads = await fetchP2POwnAds();
    const repricingSettings = await listP2PAdRepricingSettings();
    const settingsByAdId = new Map(repricingSettings.map((settings) => [settings.adId, settings]));
    res.json({
      available: true,
      ads: ads.map((ad) => ({
        id: ad.id,
        tokenId: ad.tokenId,
        currencyId: ad.currencyId,
        side: ad.side,
        price: ad.price,
        status: ad.status,
        priceType: ad.priceType ?? "",
        minAmount: ad.minAmount ?? "",
        maxAmount: ad.maxAmount ?? "",
        repricing: settingsByAdId.get(ad.id) ?? null,
      })),
    });
  } catch (error) {
    logger.error({
      errorName: error instanceof Error ? error.name : "UnknownError",
    }, "P2P own-ad list failed");
    res.status(502).json({
      error: { code: "P2P_ADS_UNAVAILABLE", message: "Unable to retrieve your Bybit advertisements" },
    });
  }
});

app.post("/api/p2p/scan", requireAuth, requireRole("admin"), p2pScanLimiter, async (_req, res) => {
  if (!config.databaseUrl) {
    res.status(503).json({
      error: { code: "DATABASE_NOT_CONFIGURED", message: "DATABASE_URL is required for P2P scan history" },
    });
    return;
  }
  const scanLock = await tryAcquireScanLock(serverInstanceId);
  try {
    const proposals = await scanAndStoreP2PProposals();
    const liveStatus = await getP2PLiveStatus();
    res.json({
      mode: liveStatus.mode,
      automaticRepricingEnabled: liveStatus.automaticRepricingEnabled,
      scannedAt: new Date().toISOString(),
      largeChangeThresholdNgn: config.p2pLargeChangeThresholdNgn,
      proposals,
    });
  } catch (error) {
    logger.error({ err: error }, "P2P dry-run scan failed");
    await pauseAutomaticRepricingForRuntimeFailure(
      "Market scan failed; inspect Bybit connectivity and database health before re-enabling",
    );
    const message = error instanceof Error ? error.message : "P2P market scan failed";
    res.status(502).json({ error: { code: "P2P_SCAN_FAILED", message } });
  } finally {
    await releaseScanLock(scanLock);
  }
});

app.get("/api/p2p/proposals", requireAuth, requireRole("admin"), async (_req, res) => {
  if (!config.databaseUrl) {
    res.status(503).json({
      error: { code: "DATABASE_NOT_CONFIGURED", message: "DATABASE_URL is required for P2P proposal history" },
    });
    return;
  }
  try {
    const [proposals, liveStatus] = await Promise.all([
      getRecentP2PProposals(),
      getP2PLiveStatus(),
    ]);
    res.json({
      mode: liveStatus.mode,
      automaticRepricingEnabled: liveStatus.automaticRepricingEnabled,
      proposals,
    });
  } catch (error) {
    logger.error({ err: error }, "P2P proposal history lookup failed");
    res.status(503).json({
      error: { code: "DATABASE_UNAVAILABLE", message: "P2P proposals are unavailable" },
    });
  }
});

app.get("/api/bybit/server-time", requireAuth, async (_req, res) => {
  try {
    logger.info({ bybitHost: new URL(config.bybitBaseUrl).host }, "Testing Bybit public API connection");
    const response = await bybitRequest("GET", "/v5/market/time");
    res.json({ bybit: response });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bybit request failed";
    res.status(502).json({ error: { code: "BYBIT_REQUEST_FAILED", message } });
  }
});

const operationSchema = z.object({
  operationType: z.enum(["bybit_server_time", "stop_bot"]),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});

app.post("/api/operations", requireAuth, requireRole("admin", "operator"), async (req, res) => {
  const parsed = operationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid operation", details: parsed.error.flatten() } });
    return;
  }
  const idempotencyKey = parsed.data.idempotencyKey ?? crypto.randomUUID();
  try {
    const created = await pool.query(
      `INSERT INTO bot_operations (idempotency_key, operation_type, status, payload, created_by)
       VALUES ($1, $2, 'pending', '{}'::jsonb, $3)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, operation_type, status, payload, result, created_at, updated_at`,
      [idempotencyKey, parsed.data.operationType, req.authUser?.username],
    );
    if (created.rowCount) {
      res.status(201).json({ operation: created.rows[0] });
      return;
    }
    const existing = await pool.query(
      "SELECT id, operation_type, status, payload, result, created_at, updated_at FROM bot_operations WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    res.status(200).json({ operation: existing.rows[0] });
  } catch (error) {
    logger.error({ err: error }, "Operation creation failed");
    res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Operation could not be persisted" } });
  }
});

app.get("/api/operations", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, operation_type, status, payload, result, created_by, created_at, updated_at FROM bot_operations ORDER BY created_at DESC LIMIT 100",
    );
    res.json({ operations: result.rows });
  } catch (error) {
    logger.error({ err: error }, "Operation listing failed");
    res.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Operations unavailable" } });
  }
});

if (config.nodeEnv === "production") {
  const clientDirectory = path.resolve(process.cwd(), "client/dist");
  app.use(express.static(clientDirectory, {
    index: "index.html",
    maxAge: "1h",
  }));
  app.get("/{*path}", (req, res, next) => {
    if (req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(path.join(clientDirectory, "index.html"));
  });
}

app.use((req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `Unknown route: ${req.method} ${req.path}` } });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err: error }, "Unhandled request error");
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : 500;
  if (status === 400) {
    res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body contains invalid JSON" } });
    return;
  }
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
});

configureAutomaticProposalHandler(async (proposalId) => {
  try {
    await applyP2PPriceProposal(proposalId, "system:auto");
    return { status: "updated", message: "Bybit accepted and verified the new advertisement price." };
  } catch (error) {
    logger.error({
      proposalId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    }, "Automatic P2P proposal execution failed");
    let liveStatus;
    try {
      liveStatus = await getP2PLiveStatus();
    } catch (statusError) {
      logger.error({
        proposalId,
        errorName: statusError instanceof Error ? statusError.name : "UnknownError",
      }, "Could not read automatic repricing status after proposal failure");
      return { status: "paused", message: "Automatic repricing paused; system status could not be verified." };
    }
    if (!liveStatus?.automaticRepricingEnabled) {
      return { status: "paused", message: "Automatic repricing paused; inspect the audit trail and system status." };
    }
    if (error instanceof P2PLiveError && error.pauseAdvertisement) {
      return { status: "paused", message: "This advertisement was paused by a safety check." };
    }
    return {
      status: error instanceof P2PLiveError && error.statusCode === 409 ? "skipped" : "failed",
      message: error instanceof P2PLiveError
        ? error.message
        : "Automatic update failed; inspect the audit trail and Bybit ad.",
    };
  }
});

async function main(): Promise<void> {
  const bybitHost = new URL(config.bybitBaseUrl).host;
  logger.info({ bybitHost }, "Using configured Bybit API host");
  await initRedis();
  if (config.databaseUrl) {
    logger.info("DATABASE_URL is configured; running migrations before server startup");
    await migrate();
    await resetP2PLiveModeAtStartup();
  } else {
    logger.warn("DATABASE_URL is not configured; database migrations are skipped");
  }
  const stopP2PScanner = config.databaseUrl ? startP2PScanner() : () => undefined;
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, "Server listening");
  });
  const shutdown = async () => {
    stopP2PScanner();
    await closeRedis();
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((error) => {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const errorCode = error && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
  logger.fatal(errorCode ? { errorName, errorCode } : { errorName }, "Startup failed");
  process.exit(1);
});
