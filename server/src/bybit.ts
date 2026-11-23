import crypto from "node:crypto";
import { config } from "./config.js";

export type BybitResponse = {
  retCode: number;
  retMsg: string;
  result: unknown;
  latencyMs: number;
  rateLimit: {
    limit: number | null;
    remaining: number | null;
    resetAt: number | null;
  };
};

export class BybitRequestError extends Error {
  constructor(
    message: string,
    readonly options: {
      retryable: boolean;
      retCode?: number;
      httpStatus?: number;
      rateLimit?: BybitResponse["rateLimit"];
    },
  ) {
    super(message);
    this.name = "BybitRequestError";
  }
}

type BybitEnvelope = {
  retCode?: number;
  ret_code?: number;
  retMsg?: string;
  ret_msg?: string;
  result?: unknown;
};

const NETWORK_ERROR_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
]);
const RETRYABLE_API_CODES = new Set([10000, 10006, 10016, 10018]);

function readRateLimit(response: Response): BybitResponse["rateLimit"] {
  const parseHeader = (name: string): number | null => {
    const value = response.headers.get(name);
    if (!value || !/^\d+$/.test(value)) return null;
    return Number(value);
  };
  return {
    limit: parseHeader("X-Bapi-Limit"),
    remaining: parseHeader("X-Bapi-Limit-Status"),
    resetAt: parseHeader("X-Bapi-Limit-Reset-Timestamp"),
  };
}

export function createBybitSignature(
  apiKey: string,
  apiSecret: string,
  timestamp: string,
  recvWindow: string,
  params: string,
): string {
  return crypto
    .createHmac("sha256", apiSecret)
    .update(timestamp + apiKey + recvWindow + params)
    .digest("hex");
}

function getNetworkErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("cause" in error)) return undefined;
  const cause = error.cause;
  if (!cause || typeof cause !== "object" || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
}

export async function bybitRequest(
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {},
  timeoutMs = 10_000,
): Promise<BybitResponse> {
  const timestamp = String(Date.now());
  const recvWindow = "5000";
  const url = new URL(path, `${config.bybitBaseUrl}/`);
  let body = "";
  let signature = "";

  if (method === "GET") {
    const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length) url.search = new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
  } else {
    body = JSON.stringify(params);
  }

  if (config.bybitApiKey && config.bybitApiSecret) {
    signature = createBybitSignature(
      config.bybitApiKey,
      config.bybitApiSecret,
      timestamp,
      recvWindow,
      method === "GET" ? url.searchParams.toString() : body,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(config.bybitApiKey ? { "X-BAPI-API-KEY": config.bybitApiKey } : {}),
        ...(signature ? { "X-BAPI-SIGN": signature } : {}),
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-SIGN-TYPE": "2",
        "X-BAPI-RECV-WINDOW": recvWindow,
      },
      body: method === "POST" ? body : undefined,
      signal: controller.signal,
    });
    const rateLimit = readRateLimit(response);
    if (!response.ok) {
      throw new BybitRequestError(`Bybit HTTP ${response.status}`, {
        retryable: response.status === 429 || response.status >= 500,
        httpStatus: response.status,
        rateLimit,
      });
    }
    const payload = await response.json() as BybitEnvelope;
    const retCode = payload.retCode ?? payload.ret_code;
    const retMsg = payload.retMsg ?? payload.ret_msg;
    if (typeof retCode !== "number" || !Number.isInteger(retCode)
      || typeof retMsg !== "string" || payload.result === undefined) {
      throw new BybitRequestError("Bybit returned an invalid response", { retryable: false, rateLimit });
    }
    if (retCode !== 0) {
      throw new BybitRequestError(`Bybit API ${retCode}: ${retMsg}`, {
        retryable: RETRYABLE_API_CODES.has(retCode),
        retCode,
        rateLimit,
      });
    }
    return {
      retCode,
      retMsg,
      result: payload.result,
      latencyMs: Date.now() - startedAt,
      rateLimit,
    };
  } catch (error) {
    if (error instanceof BybitRequestError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new BybitRequestError(
        `Bybit request to ${url.host} timed out after ${timeoutMs} ms. Check DNS and outbound HTTPS access.`,
        { retryable: true },
      );
    }

    if (NETWORK_ERROR_CODES.has(getNetworkErrorCode(error) ?? "")) {
      throw new BybitRequestError(
        `Could not connect to Bybit at ${url.host}. Check DNS, firewall, or outbound HTTPS access.`,
        { retryable: true },
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
