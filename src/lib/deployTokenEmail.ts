/**
 * Renders the deploy-token email as email-safe HTML (tables + inline styles,
 * no external assets) so the viasocket flow only has to place one variable
 * into its MSG91 template. Rendering here rather than in the template is
 * what lets the company list be any length.
 */

export interface DeployTokenEmailItem {
  company: string;
  token: string;
}

export interface DeployTokenEmailInput {
  items: DeployTokenEmailItem[];
  dashboardUrl: string;
}

export function deployTokenEmailSubject(items: DeployTokenEmailItem[]): string {
  return items.length === 1 ? "Your Embarko AI deploy token" : "Your Embarko AI deploy tokens";
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
const MONO = "font-family:SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;";

export function renderDeployTokenEmail(input: DeployTokenEmailInput): string {
  const { items, dashboardUrl } = input;
  const plural = items.length !== 1;

  const rows = items
    .map(
      ({ company, token }, index) => `
        <tr>
          <td style="padding:12px 14px; border-top:${index === 0 ? "0" : "1px solid #e6e8eb"}; font-size:14px; color:#2c3e50; vertical-align:top; white-space:nowrap;">
            ${escapeHtml(company)}
          </td>
          <td style="padding:12px 14px; border-top:${index === 0 ? "0" : "1px solid #e6e8eb"}; vertical-align:top;">
            <code style="${MONO} display:inline-block; font-size:13px; color:#1f2328; background:#f6f8fa; border:1px solid #d0d7de; border-radius:6px; padding:6px 10px; word-break:break-all;">${escapeHtml(token)}</code>
          </td>
        </tr>`
    )
    .join("");

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${FONT} background:#ffffff;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px; text-align:left;">
        <tr>
          <td style="padding:0 0 16px 0; font-size:20px; font-weight:600; color:#1f2328;">
            ${plural ? "Your deploy tokens" : "Your deploy token"}
          </td>
        </tr>
        <tr>
          <td style="padding:0 0 18px 0; font-size:14px; line-height:1.6; color:#2c3e50;">
            ${
              plural
                ? "Here is a new deploy token for each workspace you belong to."
                : "Here is a new deploy token for your workspace."
            }
            Use it as the <code style="${MONO} font-size:13px;">Authorization</code> header when deploying.
          </td>
        </tr>
        <tr>
          <td style="padding:0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #d0d7de; border-radius:8px; border-collapse:separate; overflow:hidden;">
              <tr style="background:#f6f8fa;">
                <th align="left" style="padding:10px 14px; font-size:11px; font-weight:600; color:#57606a; text-transform:uppercase; letter-spacing:0.4px;">Company</th>
                <th align="left" style="padding:10px 14px; font-size:11px; font-weight:600; color:#57606a; text-transform:uppercase; letter-spacing:0.4px;">Deploy token</th>
              </tr>
              ${rows}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 0 0 0; font-size:13px; line-height:1.6; color:#57606a;">
            ${plural ? "These are newly created tokens." : "This is a newly created token."}
            Your existing tokens keep working unchanged. Requesting again creates another new token;
            you can revoke any you no longer need from the dashboard.
          </td>
        </tr>
        <tr>
          <td style="padding:16px 0 0 0; font-size:13px; line-height:1.6; color:#57606a;">
            Manage tokens, projects and billing at
            <a href="${escapeHtml(dashboardUrl)}" style="color:#0969da; text-decoration:none;">${escapeHtml(dashboardUrl)}</a>.
          </td>
        </tr>
        <tr>
          <td style="padding:20px 0 0 0; border-top:1px solid #e6e8eb; margin-top:20px; font-size:12px; line-height:1.6; color:#8c959f;">
            If you did not request this, you can ignore it. Nothing about your account changed except that a new deploy token was added; you can revoke it from the dashboard.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`.trim();
}
