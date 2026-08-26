import { prisma } from "../lib/prisma";

export function logAudit(entry: {
  actorUserId?: string;
  companyId?: string;
  projectId?: string;
  action: string;
  details?: string;
}) {
  return prisma.auditLog.create({ data: entry });
}
