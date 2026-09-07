import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { loadCompanyContext } from "../middleware/companyContext";
import { requireProxyToken } from "../middleware/proxyToken";
import { getCompanyById, listMyCompanies, createCompany } from "../lib/msg91";
import { ensureBillingForCompany } from "../services/billingCustomer";

export const companiesRouter = Router();

// Companies are owned by MSG91 proxy. Rename, delete, and all member
// management happen through the proxy embed on the dashboard — no endpoints
// here for those. Create and the reads below go straight to proxy too, so
// the dashboard can render its nav from the same source of truth the embed
// uses.
//
// All routes here identify the caller from the proxy_auth_token alone
// (requireProxyToken sets req.userId from it) rather than our own bearer
// session — there's no local session concept these need.

companiesRouter.get("/companies", requireProxyToken, async (req, res) => {
  res.json(await listMyCompanies(req.proxyAuthToken!));
});

const createCompanySchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  meta: z.record(z.unknown()).optional(),
  timezone: z.string().optional(),
  timeZoneName: z.string().optional(),
});

// The creator becomes a member and proxy switches them into it.
//
// Billing (Stripe + Lago customer, free plan) is set up right after, best
// effort: the company already exists on proxy at that point, so a Stripe/
// Lago outage must not turn into a 5xx that makes the dashboard think the
// company wasn't created. Failure is reported as `billing: "pending"`; the
// dashboard then calls POST /companies/:companyId/billing/customer.
// Companies that never pass here (proxy's auto-created default company,
// the proxy embed) are picked up at login instead — see auth.routes.ts.
companiesRouter.post("/companies", requireProxyToken, async (req, res) => {
  const input = createCompanySchema.parse(req.body);
  const company = await createCompany(req.proxyAuthToken!, input);

  // Lago requires an email; the company's own is optional in proxy, so the
  // creator's is the fallback — they're the one who'll get invoices anyway.
  const billing = await ensureBillingForCompany(company.id, {
    name: company.name,
    email: input.email ?? req.proxyIdentity?.email ?? null,
  });

  res.status(201).json({ ...company, billing });
});

companiesRouter.get("/companies/:companyId", requireProxyToken, loadCompanyContext, async (req, res) => {
  const [company, projectCount] = await Promise.all([
    getCompanyById(req.company!.id),
    prisma.project.count({ where: { companyId: req.company!.id } }),
  ]);

  // A member a moment ago, but the company no longer resolves — deleted on
  // proxy inside the membership cache window.
  if (!company) {
    return res.status(404).json({ error: "Company not found" });
  }

  res.json({ ...company, projectCount });
});
