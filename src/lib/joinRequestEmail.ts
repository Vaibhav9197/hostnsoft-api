/**
 * The email Owners and Admins get when someone asks to join through the
 * workspace's invite link (services/inviteLinks.ts). Email-safe HTML, the
 * same way as memberInviteEmail.ts, so the viasocket flow only places one
 * variable.
 */

export interface JoinRequestEmailInput {
  workspaceName: string;
  personName: string | null;
  personEmail: string;
  // The link's rule already let them in: approving is the only step left.
  eligible: boolean;
  reason: string | null;
  reviewUrl: string;
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

export function joinRequestEmailSubject(input: Pick<JoinRequestEmailInput, "personName" | "personEmail" | "workspaceName">): string {
  return `${input.personName || input.personEmail} wants to join ${input.workspaceName} on Embarko`;
}

export function renderJoinRequestEmail(input: JoinRequestEmailInput): string {
  const who = input.personName
    ? `<strong>${escapeHtml(input.personName)}</strong> (${escapeHtml(input.personEmail)})`
    : `<strong>${escapeHtml(input.personEmail)}</strong>`;
  const note = input.eligible
    ? "They used your invite link and meet its rules. Approve them to let them in."
    : "They used your invite link but don't meet its rules, so they asked for access.";
  const reason = input.reason
    ? `<tr><td style="padding:0 0 16px 0; font-size:14px; line-height:1.5; color:#1a1916;">&ldquo;${escapeHtml(input.reason)}&rdquo;</td></tr>`
    : "";
  const url = escapeHtml(input.reviewUrl);

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${FONT} background:#ffffff;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px; text-align:left;">
        <tr>
          <td style="padding:0 0 12px 0; font-size:20px; font-weight:600; color:#1a1916;">
            Someone wants to join ${escapeHtml(input.workspaceName)}
          </td>
        </tr>
        <tr>
          <td style="padding:0 0 8px 0; font-size:15px; line-height:1.5; color:#1a1916;">
            ${who} asked to join <strong>${escapeHtml(input.workspaceName)}</strong>.
          </td>
        </tr>
        <tr>
          <td style="padding:0 0 16px 0; font-size:14px; line-height:1.5; color:#6f6a62;">${note}</td>
        </tr>
        ${reason}
        <tr>
          <td style="padding:0 0 20px 0;">
            <a href="${url}" style="display:inline-block; background:#1a1916; color:#fdfdfb; text-decoration:none; font-size:15px; font-weight:500; padding:12px 22px; border-radius:999px;">Review request</a>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 0 0 0; border-top:1px solid #e5e1d8; font-size:12px; line-height:1.5; color:#6f6a62;">
            You get this because you're an Owner or Admin of ${escapeHtml(input.workspaceName)}.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}
