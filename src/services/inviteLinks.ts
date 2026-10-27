/**
 * A workspace's invite link and the join requests it brings in. Routes in
 * routes/members.routes.ts (managing, signed-in joining) and
 * routes/publicInviteLinks.routes.ts (the signed-out preview).
 *
 * Why every join is a request: proxy only adds someone to a company when a
 * person already in it asks (msg91.ts addUserToCompany, user-key c/addUser).
 * At the moment a stranger clicks the link nobody is there to ask, and the
 * admin key has no "add this user to that company" call (createCUsers
 * matches companies by name, so it can't be used safely). So the link
 * records a JoinRequest and emails the Owners and Admins; one of them
 * approves it, as themselves, and that is when proxy adds the person.
 * `eligible` says the link's rule already let them in, so approving is one
 * click and the panel can say so.
 *
 * Eligibility only ever reads proxy's verified email for the caller
 * (req.proxyIdentity.email), never anything they typed.
 *
 * The role a link hands out is capped: Member or Billing, never Owner or
 * Admin; access is a workspace-wide level, never "chosen". Approving can
 * pick a different role, with the same Owner/Admin guard rails as an invite.
 */
import { randomBytes } from "crypto";
import { prisma } from "../lib/prisma";
import { addUserToCompany, getCompanyById, getUserById, isCompanyMember } from "../lib/msg91";
import { ensureMemberRow, MEMBER_DEFAULT_ACCESS, type Access, type AppAccess, type Role } from "../lib/permissions";
import { logAudit } from "./audit";
import { callWebhook, Webhook } from "../lib/webhooks";
import { FRONTEND_ORIGIN } from "../lib/frontendOrigin";
import { joinRequestEmailSubject, renderJoinRequestEmail } from "../lib/joinRequestEmail";
import { logger } from "../lib/logger";
import { mayManageOwnerish, nameFromEmail } from "./workspaceRoles";

export const LINK_RULES = ["anyone", "domain", "invite_only"] as const;
export type LinkRule = (typeof LINK_RULES)[number];
export const LINK_ROLES = ["member", "billing"] as const;
export const LINK_ACCESS = ["use", "edit", "full"] as const;

type LinkRow = Awaited<ReturnType<typeof prisma.inviteLink.findFirst>> & {};
type RequestRow = Awaited<ReturnType<typeof prisma.joinRequest.findFirst>> & {};

function newCode(): string {
  return randomBytes(24).toString("base64url");
}

function parseDomains(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

// "@Walkover.in " → "walkover.in". Null when it isn't a plain domain.
export function normalizeDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/^@/, "");
  return /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && d.length <= 253 ? d : null;
}

export function joinUrl(code: string): string {
  return `${FRONTEND_ORIGIN}/join/${code}`;
}

export function toLinkView(link: LinkRow) {
  return {
    id: link.id,
    url: joinUrl(link.code),
    rule: link.rule as LinkRule,
    domains: parseDomains(link.domains),
    role: link.role as Role,
    access: link.appAccess as AppAccess,
    createdBy: link.createdBy,
    createdAt: link.createdAt,
    lastUsedAt: link.lastUsedAt,
    uses: link.uses,
    active: !link.disabledAt,
  };
}

function liveLink(companyId: string) {
  return prisma.inviteLink.findFirst({ where: { companyId, disabledAt: null }, orderBy: { createdAt: "desc" } });
}

// The live link, or null when there is none (never made, or disabled).
export async function getLink(companyId: string) {
  const link = await liveLink(companyId);
  return link ? toLinkView(link) : null;
}

export interface LinkSettings {
  rule?: LinkRule;
  domains?: string[];
  role?: (typeof LINK_ROLES)[number];
  access?: (typeof LINK_ACCESS)[number];
}

export type LinkError = { status: 400; code: "domain_required" | "invalid_domain"; error: string };

function checkSettings(rule: LinkRule, domains: string[]): LinkError | null {
  if (rule === "domain" && domains.length === 0) {
    return { status: 400, code: "domain_required", error: "Add at least one email domain, like walkover.in." };
  }
  return null;
}

function cleanDomains(input: string[] | undefined): { ok: true; domains: string[] } | { ok: false; err: LinkError } {
  const out: string[] = [];
  for (const raw of input ?? []) {
    const d = normalizeDomain(raw);
    if (!d) return { ok: false, err: { status: 400, code: "invalid_domain", error: `"${raw}" isn't an email domain.` } };
    if (!out.includes(d)) out.push(d);
  }
  return { ok: true, domains: out.slice(0, 20) };
}

// Returns the live link, making one (default: anyone, Member, Can view) if
// there is none.
export async function ensureLink(actor: Access) {
  const existing = await liveLink(actor.companyId);
  if (existing) return toLinkView(existing);
  const link = await prisma.inviteLink.create({
    data: { companyId: actor.companyId, code: newCode(), createdBy: actor.userId, appAccess: MEMBER_DEFAULT_ACCESS },
  });
  await logAudit({ actorUserId: actor.userId, companyId: actor.companyId, action: "invite_link.create", details: describeLink(link) });
  return toLinkView(link);
}

export async function updateLink(actor: Access, settings: LinkSettings) {
  const current = await liveLink(actor.companyId);
  const base = current ?? null;
  const cleaned = cleanDomains(settings.domains ?? (base ? parseDomains(base.domains) : []));
  if (!cleaned.ok) return { ok: false as const, err: cleaned.err };
  const rule = settings.rule ?? ((base?.rule as LinkRule | undefined) ?? "anyone");
  const bad = checkSettings(rule, cleaned.domains);
  if (bad) return { ok: false as const, err: bad };

  const data = {
    rule,
    domains: JSON.stringify(cleaned.domains),
    role: settings.role ?? base?.role ?? "member",
    appAccess: settings.access ?? base?.appAccess ?? MEMBER_DEFAULT_ACCESS,
  };
  const link = base
    ? await prisma.inviteLink.update({ where: { id: base.id }, data })
    : await prisma.inviteLink.create({ data: { ...data, companyId: actor.companyId, code: newCode(), createdBy: actor.userId } });
  await logAudit({
    actorUserId: actor.userId,
    companyId: actor.companyId,
    action: base ? "invite_link.update" : "invite_link.create",
    details: describeLink(link),
  });
  return { ok: true as const, link: toLinkView(link) };
}

// A new code with the same settings; the old URL stops working at once.
export async function resetLink(actor: Access) {
  const old = await liveLink(actor.companyId);
  const [, link] = await prisma.$transaction([
    prisma.inviteLink.updateMany({ where: { companyId: actor.companyId, disabledAt: null }, data: { disabledAt: new Date() } }),
    prisma.inviteLink.create({
      data: {
        companyId: actor.companyId,
        code: newCode(),
        createdBy: actor.userId,
        rule: old?.rule ?? "anyone",
        domains: old?.domains ?? "[]",
        role: old?.role ?? "member",
        appAccess: old?.appAccess ?? MEMBER_DEFAULT_ACCESS,
      },
    }),
  ]);
  await logAudit({ actorUserId: actor.userId, companyId: actor.companyId, action: "invite_link.reset", details: describeLink(link) });
  return toLinkView(link);
}

export async function disableLink(actor: Access) {
  const { count } = await prisma.inviteLink.updateMany({
    where: { companyId: actor.companyId, disabledAt: null },
    data: { disabledAt: new Date() },
  });
  if (count) await logAudit({ actorUserId: actor.userId, companyId: actor.companyId, action: "invite_link.disable" });
}

function describeLink(link: LinkRow): string {
  const domains = parseDomains(link.domains);
  return `${link.rule}${domains.length ? ` (${domains.join(", ")})` : ""}, joins as ${link.role}${link.role === "member" ? ` (apps: ${link.appAccess})` : ""}`;
}

// ---------------------------------------------------------------- joining

async function linkByCode(code: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(code)) return null;
  const link = await prisma.inviteLink.findUnique({ where: { code } });
  return link && !link.disabledAt ? link : null;
}

// What a join page may show before the person is in: the workspace's name,
// who made the link, the role they'd get and the rule. Nothing else about
// the workspace. Null for any code that doesn't work, whatever the reason.
export async function previewLink(code: string) {
  const link = await linkByCode(code);
  if (!link) return null;
  const [company, inviter] = await Promise.all([
    getCompanyById(link.companyId).catch(() => null),
    getUserById(link.createdBy).catch(() => null),
  ]);
  if (!company) return null;
  return {
    workspaceName: company.name,
    inviterName: inviter?.name || null,
    role: link.role as Role,
    access: link.appAccess as AppAccess,
    rule: link.rule as LinkRule,
    domains: link.rule === "domain" ? parseDomains(link.domains) : [],
  };
}

function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

async function isEligible(link: LinkRow, email: string): Promise<boolean> {
  if (link.rule === "anyone") return true;
  if (link.rule === "domain") return parseDomains(link.domains).includes(emailDomain(email));
  const invite = await prisma.pendingInvite.findUnique({ where: { companyId_email: { companyId: link.companyId, email } } });
  return !!invite;
}

export interface Joiner {
  userId: string;
  email: string | null;
  name: string | null;
}

export type JoinResult =
  | { status: "member"; companyId: string }
  | { status: "requested"; companyId: string; eligible: boolean }
  | { status: "not_eligible" }
  | { status: "no_email" }
  | { status: "invalid" };

// The join button. Already in: say so (the panel opens the workspace).
// Eligible: a pre-approved request goes to the Owners and Admins. Not
// eligible: refused unless `askAnyway` — the "Request access" button.
export async function joinWithLink(code: string, who: Joiner, opts: { askAnyway?: boolean; reason?: string } = {}): Promise<JoinResult> {
  const link = await linkByCode(code);
  if (!link) return { status: "invalid" };
  if (await isCompanyMember(who.userId, link.companyId)) return { status: "member", companyId: link.companyId };
  const email = who.email?.trim().toLowerCase();
  if (!email) return { status: "no_email" };

  const eligible = await isEligible(link, email);
  if (!eligible && !opts.askAnyway) return { status: "not_eligible" };

  const reason = opts.reason?.trim().slice(0, 300) || null;
  const before = await prisma.joinRequest.findUnique({ where: { companyId_userId: { companyId: link.companyId, userId: who.userId } } });
  const fresh = !before || before.status !== "pending";
  const data = { email, name: who.name, linkId: link.id, eligible, reason, status: "pending", decidedBy: null, decidedAt: null };
  await prisma.$transaction([
    prisma.joinRequest.upsert({
      where: { companyId_userId: { companyId: link.companyId, userId: who.userId } },
      update: data,
      create: { companyId: link.companyId, userId: who.userId, ...data },
    }),
    prisma.inviteLink.update({ where: { id: link.id }, data: { lastUsedAt: new Date(), ...(fresh ? { uses: { increment: 1 } } : {}) } }),
  ]);
  if (fresh) {
    await logAudit({
      actorUserId: who.userId,
      companyId: link.companyId,
      action: "join_request.create",
      details: `${who.userId} (${email})${eligible ? " via link, eligible" : " via link, asked for access"}`,
    });
    // Asking twice doesn't mail the admins twice.
    await notifyAdmins(link.companyId, { email, name: who.name, eligible, reason }).catch((err) =>
      logger.warn(`[invite-links] join request email for ${link.companyId} not sent: ${(err as Error)?.message}`)
    );
  }
  return { status: "requested", companyId: link.companyId, eligible };
}

// The caller's own request for the workspace behind a link — so the join
// page can say "request sent" again after a reload. Null when none.
export async function myRequestForLink(code: string, userId: string) {
  const link = await linkByCode(code);
  if (!link) return null;
  const row = await prisma.joinRequest.findUnique({ where: { companyId_userId: { companyId: link.companyId, userId } } });
  return row ? { status: row.status, eligible: row.eligible, createdAt: row.createdAt } : null;
}

// ---------------------------------------------------------------- requests

export function toRequestView(r: RequestRow) {
  return {
    id: r.id,
    userId: r.userId,
    name: r.name,
    email: r.email,
    eligible: r.eligible,
    reason: r.reason,
    status: r.status as "pending" | "approved" | "rejected",
    createdAt: r.createdAt,
  };
}

export async function listRequests(companyId: string) {
  const rows = await prisma.joinRequest.findMany({ where: { companyId, status: "pending" }, orderBy: { createdAt: "asc" } });
  return rows.map(toRequestView);
}

export type RequestError =
  | { status: 404; code: "request_not_found"; error: string }
  | { status: 403; code: "owner_required"; error: string };

// Adds them on proxy as the approver, then writes their role here. The role
// defaults to what the link hands out (Member, Can view without one).
export async function approveRequest(
  actor: Access,
  requestId: string,
  choice: { role?: Role; access?: AppAccess },
  proxyAuthToken: string
): Promise<{ ok: true } | { ok: false; err: RequestError }> {
  const companyId = actor.companyId;
  const req = await prisma.joinRequest.findFirst({ where: { id: requestId, companyId, status: "pending" } });
  if (!req) return { ok: false, err: { status: 404, code: "request_not_found", error: "That request is gone — it may have been answered already." } };

  const link = req.linkId ? await prisma.inviteLink.findUnique({ where: { id: req.linkId } }) : null;
  const role: Role = choice.role ?? ((link?.role as Role | undefined) ?? "member");
  const appAccess: AppAccess = choice.access ?? ((link?.appAccess as AppAccess | undefined) ?? MEMBER_DEFAULT_ACCESS);
  if ((role === "owner" || role === "admin") && !(await mayManageOwnerish(actor))) {
    return { ok: false, err: { status: 403, code: "owner_required", error: "Only an Owner can make someone an Owner or Admin." } };
  }
  // "chosen" with no apps would hide everything; approving picks a level.
  const access: AppAccess = appAccess === "chosen" ? MEMBER_DEFAULT_ACCESS : appAccess;

  if (!(await isCompanyMember(req.userId, companyId))) {
    // Their row first, so the newcomer default (Member, Can view) can't win
    // the race with their first request.
    await prisma.workspaceMember.upsert({
      where: { companyId_userId: { companyId, userId: req.userId } },
      update: { role, appAccess: access },
      create: { companyId, userId: req.userId, role, appAccess: access },
    });
    try {
      await addUserToCompany(proxyAuthToken, companyId, { email: req.email, name: nameFromEmail(req.email) });
    } catch (err) {
      await prisma.workspaceMember.deleteMany({ where: { companyId, userId: req.userId } }).catch(() => undefined);
      throw err;
    }
  } else {
    await ensureMemberRow(req.userId, companyId, req.email);
  }

  await prisma.joinRequest.update({
    where: { id: req.id },
    data: { status: "approved", decidedBy: actor.userId, decidedAt: new Date() },
  });
  await logAudit({
    actorUserId: actor.userId,
    companyId,
    action: "member.join",
    details: `${req.userId} (${req.email}) joined as ${role}${role === "member" ? ` (apps: ${access})` : ""}, request approved`,
  });
  return { ok: true };
}

export async function rejectRequest(actor: Access, requestId: string): Promise<{ ok: true } | { ok: false; err: RequestError }> {
  const req = await prisma.joinRequest.findFirst({ where: { id: requestId, companyId: actor.companyId, status: "pending" } });
  if (!req) return { ok: false, err: { status: 404, code: "request_not_found", error: "That request is gone — it may have been answered already." } };
  await prisma.joinRequest.update({
    where: { id: req.id },
    data: { status: "rejected", decidedBy: actor.userId, decidedAt: new Date() },
  });
  await logAudit({
    actorUserId: actor.userId,
    companyId: actor.companyId,
    action: "join_request.reject",
    details: `${req.userId} (${req.email})`,
  });
  return { ok: true };
}

// Every Owner and Admin with an email, best effort.
async function notifyAdmins(companyId: string, who: { email: string; name: string | null; eligible: boolean; reason: string | null }) {
  const rows = await prisma.workspaceMember.findMany({ where: { companyId, role: { in: ["owner", "admin"] } }, select: { userId: true } });
  const people = await Promise.all(rows.map((r) => getUserById(r.userId).catch(() => null)));
  const to = [...new Set(people.map((p) => p?.email?.toLowerCase()).filter((e): e is string => !!e))].slice(0, 20);
  if (to.length === 0) return;
  const company = await getCompanyById(companyId).catch(() => null);
  const input = {
    workspaceName: company?.name || "your workspace",
    personName: who.name,
    personEmail: who.email,
    eligible: who.eligible,
    reason: who.reason,
    reviewUrl: `${FRONTEND_ORIGIN}/app/people`,
  };
  await callWebhook(Webhook.MEMBER_INVITE_EMAIL, {
    to: to.map((email) => ({ email })),
    subject: joinRequestEmailSubject(input),
    variables: { content: renderJoinRequestEmail(input) },
  });
}
