// Mints a local access token without going through MSG91 — for local dev
// only, when there's no live proxy_auth_token to test with (e.g. no
// browser to run the MSG91 widget in). Usage:
//   npm run dev:session -- you@example.com
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { signAccessToken } from "../src/lib/jwt";

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: npm run dev:session -- <email>");
    process.exit(1);
  }

  const user = await prisma.user.upsert({ where: { email }, update: {}, create: { email } });
  console.log(signAccessToken(user.id));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
