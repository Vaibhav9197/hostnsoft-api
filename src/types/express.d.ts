import type { Company, CompanyMembership, Project } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      company?: Company;
      membership?: CompanyMembership;
      project?: Project;
    }
  }
}
