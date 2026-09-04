import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { loadCompanyContext } from "../middleware/companyContext";
import { loadProjectContext } from "../middleware/projectContext";
import { requireRole } from "../middleware/rbac";
import { logAudit } from "../services/audit";
import { isUniqueConstraintViolation } from "../lib/prismaErrors";
import { classifyDomain, isValidDomainSyntax, type DomainType } from "../lib/customDomain";
import { verifyDomainDns } from "../lib/dnsVerify";
import { activateDomain, pushCustomDomainConfig } from "../services/customDomainActivation";
import { EDGE_HOSTNAME, ORIGIN_SERVER_IP } from "../lib/customDomainConfig";

// See docs/Customdomain-req.md. Mounted without the doc's illustrative
// "/api" prefix — every other resource in this API (companies, projects,
// tokens, env-vars) is unprefixed, so this follows that existing
// convention instead of introducing a one-off inconsistency.
export const domainsRouter = Router();
domainsRouter.use(requireAuth);

function dnsInstructionsFor(domain: string, type: DomainType) {
  return type === "apex"
    ? { type: "A" as const, name: domain, value: ORIGIN_SERVER_IP }
    : { type: "CNAME" as const, name: domain, value: EDGE_HOSTNAME };
}

const registerSchema = z.object({ domain: z.string().min(1) });

domainsRouter.post(
  "/companies/:companyId/projects/:projectId/domains",
  loadCompanyContext,
  requireRole("project_admin"),
  loadProjectContext,
  async (req, res) => {
    const { domain: rawDomain } = registerSchema.parse(req.body);
    const domain = rawDomain.toLowerCase().trim();

    if (!isValidDomainSyntax(domain)) {
      return res.status(400).json({ error: "Not a valid domain name" });
    }

    const type = classifyDomain(domain);

    // Product decision: subdomain (CNAME) mapping only — apex/root
    // domains are rejected rather than supported via an A record. Apex
    // support would mean handing every such customer the origin server's
    // real IP directly, with no CDN/proxy in front of it and no failover
    // if that IP ever changes; CNAME-only avoids both. See
    // docs/Customdomain-req.md's "Edge cases" for the underlying apex/
    // CNAME DNS limitation this sidesteps entirely by not offering it.
    if (type === "apex") {
      return res.status(400).json({
        error: `"${domain}" is an apex/root domain, which isn't supported — use a subdomain instead (e.g. "www.${domain}" or "app.${domain}")`,
      });
    }

    let created;
    try {
      created = await prisma.domain.create({
        data: { projectId: req.project!.id, domain, type },
      });
    } catch (err) {
      // Edge case: domain already claimed by another project (or this
      // one) — see docs/Customdomain-req.md "Edge cases". `domain` is
      // globally unique, so this is create-then-catch-conflict, same
      // pattern used everywhere else in this codebase for idempotent
      // creation under concurrency.
      if (!isUniqueConstraintViolation(err)) throw err;
      return res.status(409).json({ error: `"${domain}" is already registered to a project` });
    }

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      projectId: req.project!.id,
      action: "domain.register",
      details: domain,
    });

    res.status(201).json({
      domain: created.domain,
      status: created.status,
      instructions: dnsInstructionsFor(created.domain, created.type as DomainType),
    });
  }
);

domainsRouter.get(
  "/companies/:companyId/projects/:projectId/domains",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    const domains = await prisma.domain.findMany({ where: { projectId: req.project!.id } });
    res.json(domains);
  }
);

// On-demand verification — see docs/Customdomain-req.md "Verification
// mechanism". Does not activate routing until DNS actually resolves
// correctly; safe to call repeatedly while DNS is propagating.
domainsRouter.post(
  "/companies/:companyId/projects/:projectId/domains/:domain/verify",
  loadCompanyContext,
  requireRole("project_admin"),
  loadProjectContext,
  async (req, res) => {
    const domain = await prisma.domain.findFirst({
      where: { domain: req.params.domain, projectId: req.project!.id },
    });
    if (!domain) return res.status(404).json({ error: "Domain not found" });

    const type = domain.type as DomainType;
    const dnsOk = await verifyDomainDns(domain.domain, type);

    if (!dnsOk) {
      await prisma.domain.update({ where: { id: domain.id }, data: { status: "failed" } });
      return res.status(422).json({
        domain: domain.domain,
        status: "failed",
        error: "DNS does not yet point at the platform — check the instructions below and retry once it propagates",
        instructions: dnsInstructionsFor(domain.domain, type),
      });
    }

    const result = await activateDomain(domain.id);
    if (!result.activated) {
      return res.status(502).json({
        domain: domain.domain,
        status: "pending_dns",
        error: `DNS verified, but activating routing failed: ${result.error}`,
      });
    }

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      projectId: req.project!.id,
      action: "domain.verify",
      details: domain.domain,
    });

    res.json({ domain: domain.domain, status: "active" });
  }
);

domainsRouter.delete(
  "/companies/:companyId/projects/:projectId/domains/:domain",
  loadCompanyContext,
  requireRole("project_admin"),
  loadProjectContext,
  async (req, res) => {
    const domain = await prisma.domain.findFirst({
      where: { domain: req.params.domain, projectId: req.project!.id },
    });
    if (!domain) return res.status(404).json({ error: "Domain not found" });

    await prisma.domain.delete({ where: { id: domain.id } });
    // Recompute and push this project's remaining active domains so this
    // one's router and certificate are actually torn down — this can
    // never touch the project's own default *.app.<platform-domain>
    // router, since that one isn't part of the customDomains list this
    // pushes. See docs/Customdomain-req.md "Edge cases".
    await pushCustomDomainConfig(domain.projectId);

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      projectId: req.project!.id,
      action: "domain.delete",
      details: domain.domain,
    });

    res.status(204).end();
  }
);
