import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { loadCompanyContext } from "../middleware/companyContext";
import { requireProxyToken } from "../middleware/proxyToken";
import { getCompanyById, listMyCompanies, createCompany, updateCompany, switchCompany } from "../lib/msg91";
import { ensureBillingForCompany, syncBillingCustomerName } from "../services/billingCustomer";

export const companiesRouter = Router();

// Companies are owned by MSG91 proxy. Delete and all member management
// happen through the proxy embed on the dashboard — no endpoints here for
// those. Create, rename and the reads below go straight to proxy too, so
// the dashboard can render its nav from the same source of truth the embed
// uses.
//
// All routes here identify the caller from the proxy_auth_token alone
// (requireProxyToken sets req.userId from it) rather than our own bearer
// session — there's no local session concept these need.

companiesRouter.get("/companies", requireProxyToken, async (req, res) => {
  const companies = await listMyCompanies(req.proxyAuthToken!);

  // projectCount also appears on GET /companies/:companyId below — kept
  // consistent between list and get-one rather than only on the single
  // fetch. Cheap (a local DB count, not a proxy/network call), so no
  // reason to withhold it here the way health is withheld from the
  // projects list.
  const counts = await Promise.all(
    companies.map((c) => prisma.project.count({ where: { companyId: c.id } }))
  );

  res.json(companies.map((c, i) => ({ ...c, projectCount: counts[i] })));
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
    return res.status(404).json({ error: "Workspace not found" });
  }

  // Proxy sends created_at; the dashboard reads createdAt.
  res.json({ ...company, createdAt: company.created_at ?? null, projectCount });
});

const updateCompanySchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  meta: z.record(z.unknown()).optional(),
  timezone: z.string().optional(),
  timeZoneName: z.string().optional(),
});

// Partial update: anything omitted keeps its current value, and meta is
// merged key-wise (proxy itself replaces it wholesale, and requires name +
// email on every call). Proxy updates the PAT's *current* company, so the
// token is switched to :companyId first when it's pointing elsewhere.
companiesRouter.patch("/companies/:companyId", requireProxyToken, loadCompanyContext, async (req, res) => {
  const patch = updateCompanySchema.parse(req.body);
  const companyId = req.company!.id;

  const existing = await getCompanyById(companyId);
  if (!existing) {
    return res.status(404).json({ error: "Workspace not found" });
  }

  const email = patch.email ?? (existing.email as string | undefined) ?? req.proxyIdentity?.email;
  if (!email) {
    return res.status(400).json({ error: "An email is required to update the workspace" });
  }

  if (req.proxyIdentity?.company?.id !== companyId) {
    await switchCompany(req.proxyAuthToken!, companyId);
  }

  // Only fields actually being set are sent: proxy rejects some shapes it
  // never receives from its own UIs (e.g. an empty meta object).
  const company = await updateCompany(req.proxyAuthToken!, companyId, {
    name: patch.name ?? existing.name,
    email,
    ...(patch.meta
      ? { meta: { ...((existing.meta as Record<string, unknown> | undefined) ?? {}), ...patch.meta } }
      : {}),
    ...(patch.timezone ? { timezone: patch.timezone } : {}),
    ...(patch.timeZoneName ? { timeZoneName: patch.timeZoneName } : {}),
  });

  if (patch.name && patch.name !== existing.name) {
    await syncBillingCustomerName(companyId, patch.name);
  }

  res.json(company);
});
