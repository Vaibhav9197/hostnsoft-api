import { isCompanyMember } from "./msg91";

// The one authorization question every route asks: may this person do this
// thing in this workspace (and, optionally, to this app)?
//
// PLACEHOLDER until roles land (a separate branch owns the real bodies and
// keeps these exports exactly as they are). Today proxy membership is the
// whole model — see docs/CLAUDE.md "Authorization is membership-only" — so
// every permission answers the same: is userId a member of companyId.
//
// Works for a deploy token, not only a signed-in person: isCompanyMember asks
// proxy with the server's admin key, never the person's own login, so a
// user-kind token (which carries only its creator's userId) is checked
// exactly like a dashboard session. Not cached, on purpose: a removed
// member must lose access on their very next call.
export const PERMISSIONS = [
  "workspace.manage",
  "members.manage",
  "billing.manage",
  "tokens.manage",
  "app.create",
  "app.delete",
  "app.deploy",
  "app.settings",
  "app.view",
  "app.logs",
  "app.move",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

// Placeholder until roles land: any member may do anything.
export async function can(
  userId: string,
  companyId: string,
  // Unused until roles land; part of the signature so callers already say
  // what they are asking for.
  _permission: Permission,
  _projectId?: string
): Promise<boolean> {
  return isCompanyMember(userId, companyId);
}
