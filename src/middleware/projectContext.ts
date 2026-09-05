import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

// Must run after loadCompanyContext, on any route with a :projectId param.
// Without this, a Prisma call keyed only by the bare project id (e.g.
// `where: { id: req.params.projectId }`) doesn't check which company owns
// it — a member of ANY company could read or mutate another
// company's project (and its env vars, deployments) just by knowing or
// guessing a projectId. 404s rather than 403s, same reasoning as
// loadCompanyContext: don't confirm the project's existence to a company
// it doesn't belong to.
export async function loadProjectContext(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const project = await prisma.project.findFirst({
    where: { id: req.params.projectId, companyId: req.company!.id },
  });

  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }

  req.project = project;
  next();
}
