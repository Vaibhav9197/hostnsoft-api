import { Router } from "express";
import { z } from "zod";
import { requireProxyToken } from "../middleware/proxyToken";
import { loadCompanyContext } from "../middleware/companyContext";
import {
  createFeatureRequest,
  featureRequestMessageSchema,
  featureRequestTypeSchema,
} from "../services/featureRequests";

export const featureRequestsRouter = Router();
featureRequestsRouter.use(requireProxyToken);

const dashboardSchema = z.object({
  type: featureRequestTypeSchema,
  message: featureRequestMessageSchema,
});

// Path A (docs/request-feature-req.md) — logged-in dashboard user. Email
// is never asked for: it comes straight off the already-verified proxy
// identity, same as GET /auth/me. See publicFeatureRequests.routes.ts
// for path B (anonymous) — kept as a separate, unauthenticated router
// rather than mixed into this one, same one-router-one-auth-model
// convention as everywhere else (see the mount-order note in
// routes/index.ts).
featureRequestsRouter.post(
  "/companies/:companyId/feature-requests",
  loadCompanyContext,
  async (req, res) => {
    const body = dashboardSchema.parse(req.body);
    const featureRequest = await createFeatureRequest({
      ...body,
      source: "dashboard",
      email: req.proxyIdentity?.email ?? null,
      userId: req.userId,
      companyId: req.company!.id,
    });
    res.status(201).json({ id: featureRequest.id });
  }
);
