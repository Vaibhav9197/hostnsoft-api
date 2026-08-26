import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { loadCompanyContext } from "../middleware/companyContext";
import { requireRole } from "../middleware/rbac";
import { logAudit } from "../services/audit";

export const envVarsRouter = Router();
envVarsRouter.use(requireAuth);

envVarsRouter.get(
  "/companies/:companyId/projects/:projectId/env-vars",
  loadCompanyContext,
  requireRole("project_admin"),
  async (req, res) => {
    const envVars = await prisma.envVar.findMany({
      where: { projectId: req.params.projectId },
    });
    res.json(envVars);
  }
);

const upsertEnvVarsSchema = z.object({
  vars: z.array(z.object({ key: z.string().min(1), value: z.string() })),
});

// Bulk upsert. Persists here only for now — does not yet reach the running
// app. See docs/CLAUDE.md open question #3: propagating this into
// hostnsoft-deploy's Nomad job spec (and triggering a redeploy) is a
// separate, not-yet-designed integration point in that sibling repo.
envVarsRouter.put(
  "/companies/:companyId/projects/:projectId/env-vars",
  loadCompanyContext,
  requireRole("project_admin"),
  async (req, res) => {
    const { vars } = upsertEnvVarsSchema.parse(req.body);

    const results = await prisma.$transaction(
      vars.map(({ key, value }) =>
        prisma.envVar.upsert({
          where: { projectId_key: { projectId: req.params.projectId, key } },
          update: { value, updatedBy: req.userId },
          create: { projectId: req.params.projectId, key, value, updatedBy: req.userId },
        })
      )
    );

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      projectId: req.params.projectId,
      action: "env_var.upsert",
      details: vars.map((v) => v.key).join(", "),
    });
    res.json(results);
  }
);

envVarsRouter.delete(
  "/companies/:companyId/projects/:projectId/env-vars/:key",
  loadCompanyContext,
  requireRole("project_admin"),
  async (req, res) => {
    await prisma.envVar.delete({
      where: { projectId_key: { projectId: req.params.projectId, key: req.params.key } },
    });

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      projectId: req.params.projectId,
      action: "env_var.delete",
      details: req.params.key,
    });
    res.status(204).end();
  }
);
