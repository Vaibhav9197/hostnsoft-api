// Deliberately the ONLY way to grant admin access — see docs/admin-panel.md
// Part 3. No API/UI does this on purpose, to keep the set of people who can
// grant it limited to those with direct access to run this script (or the
// equivalent manual SQL) against the database, not anything reachable over
// HTTP.
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
