import { Router } from "express";
import { z } from "zod";
import {
  createFeatureRequest,
  featureRequestMessageSchema,
  featureRequestTypeSchema,
} from "../services/featureRequests";

export const internalCustomerQueryRouter = Router();

const schema = z.object({
  type: featureRequestTypeSchema,
  message: featureRequestMessageSchema,
  projectSlug: z.string().min(1),
  agentName: z.string().trim().min(1).max(100),
  companyId: z.string().min(1).nullable(),
});

// Path C (docs/request-feature-req.md) — called by hostnsoft-deploy's
// POST /apps/:appName/customer-query, itself called by whatever AI agent
// a customer is using to deploy. Same trust model as every other
// /internal/* route: no requireProxyToken, network-level trust between
// the two services — hostnsoft-deploy has already resolved
// projectSlug -> companyId/isOrphan (via project-lookup.js, the same
// call GET /apps/:appName/status's auth already makes) before calling
// this, so there is nothing left here to re-authorize.
//
// Renamed from /internal/feature-requests to /internal/customer-query
// (2026-09-09) — see customerQuery.routes.ts.
internalCustomerQueryRouter.post("/internal/customer-query", async (req, res) => {
  const body = schema.parse(req.body);
  const featureRequest = await createFeatureRequest({
    type: body.type,
    message: body.message,
    source: "agent",
    projectSlug: body.projectSlug,
    agentName: body.agentName,
    companyId: body.companyId,
  });
  res.status(201).json({ id: featureRequest.id });
});
