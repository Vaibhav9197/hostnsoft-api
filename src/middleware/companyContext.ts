import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

// Loads the caller's membership for :companyId and attaches req.company /
// req.membership. Must run after requireAuth. A user with no membership
// row for this company gets a 404 rather than 403, so as not to confirm
// the company's existence to non-members.
export async function loadCompanyContext(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const { companyId } = req.params;

  const membership = await prisma.companyMembership.findUnique({
    where: { userId_companyId: { userId: req.userId!, companyId } },
    include: { company: true },
  });

  if (!membership) {
    return res.status(404).json({ error: "Company not found" });
  }

  req.company = membership.company;
  req.membership = membership;
  next();
}
