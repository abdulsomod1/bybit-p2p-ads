import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "password",
      "apiKey",
      "apiSecret",
      "signature",
      "token",
    ],
    remove: true,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: "bybit-p2p-bot", env: config.nodeEnv },
});
