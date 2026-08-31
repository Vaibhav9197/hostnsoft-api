import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../lib/jwt";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

  if (!token) {
    return res.status(401).json({ error: "Missing bearer access token" });
  }

  try {
    const { userId } = verifyAccessToken(token);
    req.userId = userId;
    next();
  } catch (err) {
    console.warn(
      `[requireAuth] rejected ${req.method} ${req.path}: ${(err as Error)?.message ?? err}`
    );
    return res.status(401).json({ error: "Invalid or expired access token" });
  }
}
