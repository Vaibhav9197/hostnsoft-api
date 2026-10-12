import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { logger } from "../lib/logger";
import { ProxyError } from "../lib/msg91";
import { BillingError } from "../lib/billingUtility";

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Validation failed",
      // Carries a `code` like every other error body: the public docs
      // tell callers to branch on `code` rather than on `error` wording,
      // and a validation failure was the one case that didn't have one.
      code: "validation_failed",
      details: err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  // Proxy and billing (Lago/Stripe) failures carry their own status and
  // client-safe message, so routes don't translate them individually.
  // Rejected credentials are routine (warn); outages are not (error).
  if (err instanceof ProxyError || err instanceof BillingError) {
    const line = `[errorHandler] ${req.method} ${req.path} -> ${err.status}: ${err.message}`;
    if (err.status >= 500) logger.error(line);
    else logger.warn(line);
    const details = err instanceof BillingError && err.details !== undefined ? { details: err.details } : {};
    return res.status(err.status).json({ error: err.publicMessage, code: err.code, ...details });
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
