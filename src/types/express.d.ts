import type { Company, CompanyMembership } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      company?: Company;
      membership?: CompanyMembership;
    }
  }
}
