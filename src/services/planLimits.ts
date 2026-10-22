import type { Project } from "@prisma/client";

/**
 * Whether a workspace's plan has room for one more app (this one), as the
 * reason to refuse, or null when it does.
 *
 * Checked when an app is MOVED into a workspace (services/projectMove.ts).
 * Investigated 2026-10-21: creating an app enforces no plan limit today —
 * neither POST /companies/:companyId/projects nor the deploy claim
 * (services/projectClaim.ts) counts apps or memory, and Lago plans carry no
 * app-count or memory charge to read one from (lib/lago.ts, docs/billing.md).
 * So this answers "room" for everyone, and a move is held to exactly what a
 * create is held to: nothing. It exists so the day a plan limit lands there
 * is one function to put it in, and create and move call it alike — a move
 * must never be a way round a limit a create would hit.
 */
export async function appLimitRefusal(
  _companyId: string,
  _project: Pick<Project, "id" | "memoryMb">
): Promise<{ code: "plan_limit_reached"; reason: string } | null> {
  return null;
}
