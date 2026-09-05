import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { logger } from "../lib/logger";
import { ProxyError } from "../lib/msg91";

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Validation failed",
      details: err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  // Proxy failures carry their own status and client-safe message, so routes
  // don't translate them individually. Rejected credentials are routine
  // (warn); outages are not (error).
  if (err instanceof ProxyError) {
    const line = `[errorHandler] ${req.method} ${req.path} -> ${err.status}: ${err.message}`;
    if (err.status >= 500) logger.error(line);
    else logger.warn(line);
    return res.status(err.status).json({ error: err.publicMessage, code: err.code });
  }

  // body-parser's malformed-JSON error (and similar http-errors objects)
  // already carries the right client-error status — honor it.
  const knownStatus = (err as { statusCode?: unknown; status?: unknown } | null)
    ?.statusCode as number | undefined;
  const status = knownStatus ?? (err as { status?: number } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return res.status(status).json({ error: (err as Error)?.message ?? "Bad request" });
  }

  logger.error(`[errorHandler] ${req.method} ${req.path} ->`, err);
  res.status(500).json({ error: "Internal server error" });
}
