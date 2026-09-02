import { prisma } from "../lib/prisma";
import { isUniqueConstraintViolation } from "../lib/prismaErrors";
import type { Msg91Identity } from "../lib/msg91";

export async function findOrCreateUserFromMsg91(identity: Msg91Identity) {
  let user = await prisma.user.findUnique({ where: { msg91Id: identity.id } });

  // Not linked yet — if a company_admin already invited this email, link
  // the existing row instead of creating a duplicate account.
  if (!user && identity.email) {
    const byEmail = await prisma.user.findUnique({ where: { email: identity.email } });
    if (byEmail) {
      user = await prisma.user.update({
        where: { id: byEmail.id },
        data: { msg91Id: identity.id, name: identity.name },
      });
    }
  }

  if (!user) {
    user = await prisma.user.create({
      data: {
        email: identity.email ?? `${identity.id}@msg91.proxy`,
        name: identity.name,
        msg91Id: identity.id,
      },
    });
  }

  // First login for this email activates any memberships a company_admin
  // invited them into beforehand. See docs/CLAUDE.md "Members". Confirmed
  // business rule: an invited member's MSG91 identity always resolves to
  // the same company they were invited under, so this never conflicts
  // with the company lookup below over which company they end up in.
  await prisma.companyMembership.updateMany({
    where: { userId: user.id, status: "invited" },
    data: { status: "active" },
  });

  if (identity.company) {
    await joinOrCreateCompany(user.id, identity.company);
  }

  return user;
}

// An Embarko Company IS the same entity MSG91 calls "currentCompany" on a
// verified identity — not two things joined by a mapping. This finds the
// Company row for that MSG91 id (creating it on first sight) and ensures
// the user has a membership in it.
//
// Confirmed rules (2026-08-25):
// - No Company row exists yet for this MSG91 company -> this login
//   creates it, and this user becomes its company_admin.
// - The Company already exists (this person just wasn't a member of it
//   yet) -> they join as a viewer, promotable later by an existing
//   company_admin.
// - An invited member already has a CompanyMembership row (with whatever
//   role the inviting company_admin picked) before they ever log in —
//   that row is left untouched here; this function never downgrades or
//   removes a membership, only adds one when none exists.
//
// Both the company-create and membership-create below use a create-then-
// catch-conflict pattern rather than check-then-create, so two people
// from a brand-new, never-before-seen company logging in at nearly the
// same time can't both "win" company creation and crash on the unique
// constraint — whichever create() actually succeeds becomes company_admin.
async function joinOrCreateCompany(
  userId: string,
  msg91Company: { id: string; name: string }
) {
  const { companyId, justCreated } = await findOrCreateCompany(msg91Company);

  try {
    await prisma.companyMembership.create({
      data: {
        userId,
        companyId,
        role: justCreated ? "company_admin" : "viewer",
        status: "active",
      },
    });
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;
    // Membership already exists (invited beforehand, or a concurrent
    // login raced us here) — leave it as-is.
    console.log(
      `[joinOrCreateCompany] membership already exists for user ${userId} in company ${companyId} — skipping create`
    );
  }
}

async function findOrCreateCompany(
  msg91Company: { id: string; name: string }
): Promise<{ companyId: string; justCreated: boolean }> {
  try {
    const company = await prisma.company.create({
      data: { name: msg91Company.name, msg91Id: msg91Company.id },
    });
    return { companyId: company.id, justCreated: true };
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;
    // Another login for this MSG91 company won the create race between our
    // attempt and now — fetch the row it created instead of failing.
    console.log(
      `[findOrCreateCompany] lost create race for msg91Id ${msg91Company.id} — fetching the winner's row`
    );
    const company = await prisma.company.findUniqueOrThrow({
      where: { msg91Id: msg91Company.id },
    });
    return { companyId: company.id, justCreated: false };
  }
}
