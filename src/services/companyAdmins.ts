import { prisma } from "../lib/prisma";

// A company must always have at least one active company_admin
// (docs/CLAUDE.md "Non-functional expectations") — call before removing a
// member or changing a role away from company_admin, passing the
// affected userId so they're excluded from the count.
export async function wouldLeaveCompanyWithoutAdmin(
  companyId: string,
  excludingUserId: string
): Promise<boolean> {
  const remainingAdmins = await prisma.companyMembership.count({
    where: {
      companyId,
      role: "company_admin",
      status: "active",
      userId: { not: excludingUserId },
    },
  });
  return remainingAdmins === 0;
}
