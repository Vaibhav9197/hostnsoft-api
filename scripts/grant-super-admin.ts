// Bootstrap path for admin access: the FIRST super admin has to be created
// here (or via the equivalent manual SQL), since POST /admin/super-admins
// (src/routes/admin.routes.ts) requires the caller to already be a super
// admin. Once one exists, existing admins can grant and revoke over HTTP
// (POST and DELETE /admin/super-admins). This script stays the only way
// back in if the table is ever emptied entirely.
//
// Usage: npx tsx scripts/grant-super-admin.ts <proxyUserId>
// Revoke: npx tsx scripts/grant-super-admin.ts --revoke <proxyUserId>
import { prisma } from "../src/lib/prisma";

async function main() {
  const args = process.argv.slice(2);
  const revoke = args[0] === "--revoke";
  const userId = revoke ? args[1] : args[0];

  if (!userId) {
    console.error("Usage: npx tsx scripts/grant-super-admin.ts [--revoke] <proxyUserId>");
    process.exit(1);
  }

  if (revoke) {
    await prisma.superAdmin.deleteMany({ where: { userId } });
    console.log(`Revoked super admin from ${userId} (no-op if they weren't one).`);
  } else {
    await prisma.superAdmin.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    console.log(`Granted super admin to ${userId}.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
