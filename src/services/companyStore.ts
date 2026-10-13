import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

type CompanyPatch = { planCode?: string; lagoCustomerId?: string; stripeCustomerId?: string };

// Best effort: the mirror must never fail a billing call.
export async function rememberCompany(companyId: string, patch: CompanyPatch): Promise<void> {
  try {
    await prisma.company.upsert({
      where: { id: companyId },
      create: { id: companyId, ...patch },
      update: patch,
    });
  } catch (err) {
    logger.warn(`[company] could not store ${JSON.stringify(patch)} for ${companyId}: ${(err as Error).message}`);
  }
}

export function getStoredPlanCode(companyId: string): Promise<string | null> {
  return prisma.company
    .findUnique({ where: { id: companyId }, select: { planCode: true } })
    .then((c) => c?.planCode ?? null);
}
