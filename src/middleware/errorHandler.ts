import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export function errorHandler(
  err: unknown,
  _req: Request,
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

  // body-parser's malformed-JSON error (and similar http-errors-style
  // objects) already carries the right client-error status — honor it
  // instead of flattening every non-Zod error to 500.
  const knownStatus = (err as { statusCode?: unknown; status?: unknown } | null)
    ?.statusCode as number | undefined;
  const status = knownStatus ?? (err as { status?: number } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return res.status(status).json({ error: (err as Error)?.message ?? "Bad request" });
  }

  console.error(err);
  const message = err instanceof Error ? err.message : "Internal server error";
  res.status(500).json({ error: message });
}
