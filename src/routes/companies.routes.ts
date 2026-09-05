import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { loadCompanyContext } from "../middleware/companyContext";
import { requireProxyToken } from "../middleware/proxyToken";
import { getCompanyById, listMyCompanies, createCompany } from "../lib/msg91";

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
companiesRouter.post("/companies", requireProxyToken, async (req, res) => {
  const company = createCompanySchema.parse(req.body);
  res.status(201).json(await createCompany(req.proxyAuthToken!, company));
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
