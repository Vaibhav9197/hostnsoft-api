import type { Request, Response, NextFunction } from "express";
import { roleAtLeast, type Role } from "../types/roles";

// Must run after loadCompanyContext. project_admin scoping to *specific*
// projects (vs. every project in the company) isn't modeled yet — see
// docs/CLAUDE.md's auth open questions.
export function requireRole(minimum: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.membership || !roleAtLeast(req.membership.role, minimum)) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }
    next();
  };
}
