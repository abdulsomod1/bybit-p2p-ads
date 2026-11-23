import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config.js";

export type AuthUser = { username: string; role: "admin" | "operator" | "viewer" };

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
      requestId?: string;
    }
  }
}

export function issueToken(user: AuthUser): string {
  return jwt.sign(user, config.jwtSecret, { expiresIn: "8h", issuer: "bybit-p2p-bot" });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.session as string | undefined;
  if (!token) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
    return;
  }
  try {
    const decoded = jwt.verify(token, config.jwtSecret, { issuer: "bybit-p2p-bot" });
    if (typeof decoded !== "object") {
      res.status(401).json({ error: { code: "INVALID_SESSION", message: "Session is invalid or expired" } });
      return;
    }
    if (typeof decoded.username !== "string") {
      res.status(401).json({ error: { code: "INVALID_SESSION", message: "Session is invalid or expired" } });
      return;
    }
    if (decoded.role !== "admin" && decoded.role !== "operator" && decoded.role !== "viewer") {
      res.status(401).json({ error: { code: "INVALID_SESSION", message: "Session is invalid or expired" } });
      return;
    }
    const authUser: AuthUser = { username: decoded.username, role: decoded.role };
    req.authUser = authUser;
    next();
  } catch {
    res.status(401).json({ error: { code: "INVALID_SESSION", message: "Session is invalid or expired" } });
  }
}

export function requireRole(...roles: AuthUser["role"][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authUser || !roles.includes(req.authUser.role)) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Insufficient permissions" } });
      return;
    }
    next();
  };
}
