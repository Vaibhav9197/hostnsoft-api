import { Router, type Request } from "express";
import { createLimiter, type LimitScope } from "../lib/rateLimit";
import {
  PUBLIC_PLANS_RATE_GLOBAL,
  PUBLIC_PLANS_RATE_PER_IP,
  PUBLIC_PLANS_RATE_WINDOW_MS,
} from "../lib/publicPlansConfig";
import { listLagoPlans } from "../lib/lago";

export const publicBillingRouter = Router();

// Anonymous request, no body to key on: IP plus a global ceiling is the
// whole defence. Own Redis prefix, so it can't eat other endpoints' budgets.
function limiter(scope: LimitScope, limit: number, keyGenerator: (req: Request) => string) {
  return createLimiter(
    "public-plans",
    "plan catalogue requests",
    scope,
    limit,
    PUBLIC_PLANS_RATE_WINDOW_MS,
    keyGenerator
  );
}

// Open + rate-limited: the catalogue a signed-out pricing page shows.
// listLagoPlans filters to PUBLIC_PLAN_CODES, so nothing private leaks.
// Mounted before every requireProxyToken router (see routes/index.ts).
publicBillingRouter.get(
  "/billing/plans",
  limiter("ip", PUBLIC_PLANS_RATE_PER_IP, (req) => req.ip ?? "unknown"),
  limiter("global", PUBLIC_PLANS_RATE_GLOBAL, () => "all"),
  async (_req, res) => {
    res.json(await listLagoPlans());
  }
);
