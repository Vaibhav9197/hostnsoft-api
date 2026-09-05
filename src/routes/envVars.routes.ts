import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireProxyToken } from "../middleware/proxyToken";
import { loadCompanyContext } from "../middleware/companyContext";
import { loadProjectContext } from "../middleware/projectContext";
import { logAudit } from "../services/audit";

export const envVarsRouter = Router();
envVarsRouter.use(requireProxyToken);

envVarsRouter.get(
  "/companies/:companyId/projects/:projectId/env-vars",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    const envVars = await prisma.envVar.findMany({
      where: { projectId: req.project!.id },
    });
    res.json(envVars);
  }
);

// Restricted to standard env-var identifier syntax — hostnsoft-deploy
// embeds `key` as a bare, unquoted attribute name directly in generated
// Nomad job-spec HCL (`env { KEY = "value" }`, see nomad-job-spec.js).
// An unrestricted key could break out of that block and inject arbitrary
// job-spec content; this is the actual enforcement point; the value side
// is safe since it's always inside a quoted+escaped string literal.
const ENV_VAR_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const upsertEnvVarsSchema = z.object({
  vars: z.array(
    z.object({
      key: z.string().min(1).regex(ENV_VAR_KEY_PATTERN, "Must be a valid env var name (letters, digits, underscore; can't start with a digit)"),
      value: z.string(),
    })
  ),
});

// Bulk upsert. Now actually reaches the running app — see
// hostnsoft-deploy's nomad-job-spec.js, which bakes these into the
// Nomad job spec's env block on every deploy.
envVarsRouter.put(
  "/companies/:companyId/projects/:projectId/env-vars",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    const { vars } = upsertEnvVarsSchema.parse(req.body);
    const projectId = req.project!.id;

    const results = await prisma.$transaction(
      vars.map(({ key, value }) =>
        prisma.envVar.upsert({
          where: { projectId_key: { projectId, key } },
          update: { value, updatedBy: req.userId },
          create: { projectId, key, value, createdBy: req.userId!, updatedBy: req.userId },
        })
      )
    );

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      projectId,
      action: "env_var.upsert",
      details: vars.map((v) => v.key).join(", "),
    });
    res.json(results);
  }
);

envVarsRouter.delete(
  "/companies/:companyId/projects/:projectId/env-vars/:key",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    await prisma.envVar.delete({
      where: { projectId_key: { projectId: req.project!.id, key: req.params.key } },
    });

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      projectId: req.project!.id,
      action: "env_var.delete",
      details: req.params.key,
    });
    res.status(204).end();
  }
);
