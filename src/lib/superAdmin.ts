import { prisma } from "./prisma";

// Shared by requireSuperAdmin (the /admin/* gate) and every place user
// data gets serialized to the frontend (GET /auth/me, POST
// /auth/msg91/exchange) — see docs/admin-panel.md's updated policy: this
// flag IS now sent to the client, specifically so the dashboard can show
// its admin-only routes conditionally. The /admin/* API routes remain
// the actual enforcement point regardless of what the client renders.
export async function isSuperAdmin(userId: string): Promise<boolean> {
  const admin = await prisma.superAdmin.findUnique({ where: { userId } });
  return admin !== null;
}
