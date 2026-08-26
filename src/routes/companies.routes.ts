import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { loadCompanyContext } from "../middleware/companyContext";
import { requireRole } from "../middleware/rbac";
import { logAudit } from "../services/audit";
import { wouldLeaveCompanyWithoutAdmin } from "../services/companyAdmins";
import { ROLES } from "../types/roles";

export const companiesRouter = Router();
companiesRouter.use(requireAuth);

const createCompanySchema = z.object({ name: z.string().min(1) });

// Creator becomes company_admin of the new company.
companiesRouter.post("/companies", async (req, res) => {
  const { name } = createCompanySchema.parse(req.body);

  const company = await prisma.company.create({
    data: {
      name,
      memberships: { create: { userId: req.userId!, role: "company_admin" } },
    },
  });

  await logAudit({ actorUserId: req.userId, companyId: company.id, action: "company.create" });
  res.status(201).json(company);
});

companiesRouter.get("/companies", async (req, res) => {
  const memberships = await prisma.companyMembership.findMany({
    where: { userId: req.userId! },
    include: { company: true },
  });
  res.json(memberships.map((m) => ({ ...m.company, role: m.role, status: m.status })));
});

companiesRouter.get("/companies/:companyId", loadCompanyContext, async (req, res) => {
  const [memberCount, projectCount] = await Promise.all([
    prisma.companyMembership.count({ where: { companyId: req.company!.id } }),
    prisma.project.count({ where: { companyId: req.company!.id } }),
  ]);
  res.json({ ...req.company, role: req.membership!.role, memberCount, projectCount });
});

const renameCompanySchema = z.object({ name: z.string().min(1) });

companiesRouter.patch(
  "/companies/:companyId",
  loadCompanyContext,
  requireRole("company_admin"),
  async (req, res) => {
    const { name } = renameCompanySchema.parse(req.body);
    const company = await prisma.company.update({
      where: { id: req.company!.id },
      data: { name },
    });
    await logAudit({
      actorUserId: req.userId,
      companyId: company.id,
      action: "company.rename",
      details: name,
    });
    res.json(company);
  }
);

// Blocked while the company still has projects — don't silently
// cascade-delete running apps. See docs/CLAUDE.md "Orgs" (endpoint table).
companiesRouter.delete(
  "/companies/:companyId",
  loadCompanyContext,
  requireRole("company_admin"),
  async (req, res) => {
    const projectCount = await prisma.project.count({ where: { companyId: req.company!.id } });
    if (projectCount > 0) {
      return res.status(409).json({
        error: `Company still has ${projectCount} project(s) — delete or transfer them first`,
      });
    }

    await prisma.company.delete({ where: { id: req.company!.id } });
    await logAudit({
      actorUserId: req.userId,
      action: "company.delete",
      details: req.company!.id,
    });
    res.status(204).end();
  }
);

const addMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(ROLES),
});

// Invites by email. If the email has never logged in, the member starts
// as status "invited" and flips to "active" on their first login (see
// docs/CLAUDE.md "Members" and src/routes/auth.routes.ts).
companiesRouter.post(
  "/companies/:companyId/members",
  loadCompanyContext,
  requireRole("company_admin"),
  async (req, res) => {
    const { email, role } = addMemberSchema.parse(req.body);

    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: { email },
    });
    const status = user.msg91Id ? "active" : "invited";

    const membership = await prisma.companyMembership.upsert({
      where: { userId_companyId: { userId: user.id, companyId: req.company!.id } },
      update: { role },
      create: { userId: user.id, companyId: req.company!.id, role, status },
    });

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      action: "company.member.add",
      details: `${email} as ${role}`,
    });
    res.status(201).json(membership);
  }
);

companiesRouter.get("/companies/:companyId/members", loadCompanyContext, async (req, res) => {
  const members = await prisma.companyMembership.findMany({
    where: { companyId: req.company!.id },
    include: { user: true },
  });
  res.json(
    members.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      role: m.role,
      status: m.status,
    }))
  );
});

const updateRoleSchema = z.object({ role: z.enum(ROLES) });

companiesRouter.patch(
  "/companies/:companyId/members/:userId",
  loadCompanyContext,
  requireRole("company_admin"),
  async (req, res) => {
    const { role } = updateRoleSchema.parse(req.body);
    const current = await prisma.companyMembership.findUnique({
      where: { userId_companyId: { userId: req.params.userId, companyId: req.company!.id } },
    });
    if (!current) return res.status(404).json({ error: "Member not found" });

    if (current.role === "company_admin" && role !== "company_admin") {
      if (await wouldLeaveCompanyWithoutAdmin(req.company!.id, req.params.userId)) {
        return res
          .status(400)
          .json({ error: "Company must keep at least one company_admin" });
      }
    }

    const membership = await prisma.companyMembership.update({
      where: { userId_companyId: { userId: req.params.userId, companyId: req.company!.id } },
      data: { role },
    });

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      action: "company.member.role_change",
      details: `${req.params.userId} -> ${role}`,
    });
    res.json(membership);
  }
);

companiesRouter.delete(
  "/companies/:companyId/members/:userId",
  loadCompanyContext,
  requireRole("company_admin"),
  async (req, res) => {
    const current = await prisma.companyMembership.findUnique({
      where: { userId_companyId: { userId: req.params.userId, companyId: req.company!.id } },
    });
    if (!current) return res.status(404).json({ error: "Member not found" });

    if (
      current.role === "company_admin" &&
      (await wouldLeaveCompanyWithoutAdmin(req.company!.id, req.params.userId))
    ) {
      return res.status(400).json({ error: "Company must keep at least one company_admin" });
    }

    await prisma.companyMembership.delete({
      where: { userId_companyId: { userId: req.params.userId, companyId: req.company!.id } },
    });

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      action: "company.member.remove",
      details: req.params.userId,
    });
    res.status(204).end();
  }
);
