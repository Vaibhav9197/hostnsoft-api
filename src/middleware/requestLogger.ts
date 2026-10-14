import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { runWithRequestId } from "../lib/requestContext";
import { logger } from "../lib/logger";

// Mounted first, before helmet/cors/everything else, so the request id
// covers the entire lifecycle of the request — every log line made
// anywhere while handling it (including the error handler) picks this up
// automatically via AsyncLocalStorage. Also echoed back as a response
// header so a caller can report this id back for support.
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const requestId = randomUUID();
  res.setHeader("X-Request-Id", requestId);

  const url = redactSecrets(req.originalUrl);
  // deploy-service polls /health once a minute for the uptime monitor;
  // logging every healthy answer would add ~2900 lines a day. A failing
  // one is still logged, alongside the health route's own reason.
  const quiet = req.path === "/health";

  runWithRequestId(requestId, () => {
    if (!quiet) logger.info(`--> ${req.method} ${url}`);
    res.on("finish", () => {
      if (quiet && res.statusCode < 400) return;
      logger.info(`<-- ${req.method} ${url} ${res.statusCode}`);
    });
    next();
  });
}

// GET /auth/msg91/callback receives the proxy_auth_token in the query
// string, so the raw URL must never be logged as-is.
function redactSecrets(url: string): string {
  return url.replace(/([?&]proxy_auth_token=)[^&]*/gi, "$1[redacted]");
}
