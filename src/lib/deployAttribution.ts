import { z } from "zod";

// Who a Deployment row is attributed to — see schema.prisma's
// Deployment.source / agentName. `source` is always derived from the
// credential that made the call; `agentName` is the caller's own,
// unverified description of itself.
export type DeploySource = "dashboard" | "agent";

export type DeployAttribution = {
  triggeredBy: string;
  source: DeploySource;
  agentName: string | null;
};

// Same shape hostnsoft-deploy enforces on X-Agent-Name for POST /apps:
// a short printable-ASCII label, since it travels as an HTTP header.
export const agentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\x20-\x7E]+$/);

// Lenient read for the agent management routes (rollback, config apply):
// a missing or malformed header records no name rather than failing a
// call whose real job is something else.
export function readAgentName(header: unknown): string | null {
  const parsed = agentNameSchema.safeParse(Array.isArray(header) ? header[0] : header);
  return parsed.success ? parsed.data : null;
}
