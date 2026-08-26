export const ROLES = ["company_admin", "project_admin", "viewer"] as const;
export type Role = (typeof ROLES)[number];

// company_admin implicitly has every project_admin/viewer permission
// across every project in the company (see docs/CLAUDE.md "Notes on roles").
const RANK: Record<Role, number> = {
  viewer: 0,
  project_admin: 1,
  company_admin: 2,
};

export function roleAtLeast(role: string, minimum: Role): boolean {
  return (RANK[role as Role] ?? -1) >= RANK[minimum];
}
