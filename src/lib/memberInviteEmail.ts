/**
 * The invite email for someone added to a workspace — rendered here as
 * email-safe HTML (tables + inline styles, no external assets), the same way
 * as deployTokenEmail.ts, so the viasocket flow only places one variable.
 * Proxy's addUser adds the person but sends no email of its own.
 */

export interface MemberInviteEmailInput {
  email: string;
  inviterName: string | null;
  workspaceName: string;
  // "Admin", "Member", "Billing", or "Owner".
  roleName: string;
  // A Member's access in words ("Can use all apps", "3 apps"), else null.
  accessSummary: string | null;
  signInUrl: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

export function memberInviteEmailSubject(input: Pick<MemberInviteEmailInput, "inviterName" | "workspaceName">): string {
  return input.inviterName
    ? `${input.inviterName} invited you to ${input.workspaceName} on Embarko`
    : `You're invited to ${input.workspaceName} on Embarko`;
}

export function renderMemberInviteEmail(input: MemberInviteEmailInput): string {
  const who = input.inviterName ? `${escapeHtml(input.inviterName)} added you` : "You've been added";
  const role = escapeHtml(input.roleName);
  const access = input.accessSummary ? ` · ${escapeHtml(input.accessSummary)}` : "";
  const url = escapeHtml(input.signInUrl);

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${FONT} background:#ffffff;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px; text-align:left;">
        <tr>
          <td style="padding:0 0 12px 0; font-size:20px; font-weight:600; color:#1a1916;">
            Join ${escapeHtml(input.workspaceName)} on Embarko
          </td>
        </tr>
        <tr>
          <td style="padding:0 0 8px 0; font-size:15px; line-height:1.5; color:#1a1916;">
            ${who} to <strong>${escapeHtml(input.workspaceName)}</strong>, where your team's apps live.
          </td>
        </tr>
        <tr>
          <td style="padding:0 0 20px 0; font-size:14px; color:#6f6a62;">
            Your role: ${role}${access}
          </td>
        </tr>
        <tr>
          <td style="padding:0 0 20px 0;">
            <a href="${url}" style="display:inline-block; background:#1a1916; color:#fdfdfb; text-decoration:none; font-size:15px; font-weight:500; padding:12px 22px; border-radius:999px;">Open Embarko</a>
          </td>
        </tr>
        <tr>
          <td style="padding:0 0 8px 0; font-size:14px; line-height:1.5; color:#6f6a62;">
            Sign in with ${escapeHtml(input.email)}. Or open <a href="${url}" style="color:#1a1916;">${url}</a>.
          </td>
        </tr>
        <tr>
          <td style="padding:16px 0 0 0; border-top:1px solid #e5e1d8; font-size:12px; line-height:1.5; color:#6f6a62;">
            Not expecting this? You can ignore this email.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}
