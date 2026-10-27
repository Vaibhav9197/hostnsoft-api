# Member invite email (viasocket flow)

Sent from `POST /companies/:companyId/invites`, after MSG91 has added the
person to the workspace (proxy's `c/addUser` sends no email of its own). The
API does not talk to a mail provider directly: `sendInviteEmail` in
`src/services/workspaceRoles.ts` POSTs the payload below to the viasocket
webhook `Webhook.MEMBER_INVITE_EMAIL` (URL constant in `src/lib/webhooks.ts`),
and the viasocket flow sends the email through MSG91.

The email body is rendered **in this API** (`src/lib/memberInviteEmail.ts`),
the same way as the deploy token email, so the flow's MSG91 template needs
exactly one variable, `content`, placed where the body goes.

## Payload

```json
{
  "to": [{ "email": "asha@acme.dev" }],
  "subject": "Ravi invited you to Acme on Embarko",
  "variables": {
    "content": "<table role=\"presentation\" …>…</table>"
  }
}
```

| Field | Meaning |
|---|---|
| `to[0].email` | The invited email (trimmed, lowercased) |
| `subject` | `"<inviter name> invited you to <workspace> on Embarko"`; when the inviter's name can't be read from MSG91, `"You're invited to <workspace> on Embarko"` |
| `variables.content` | Email-safe HTML (tables, inline styles, no external assets): a "Join <workspace> on Embarko" heading, who added them, their role (Owner, Admin, Member, Billing) and, for a Member, their access in words ("Can use all apps", "Can edit all apps", "Full access to all apps", or "N apps" for chosen apps), an "Open Embarko" button to `<FRONTEND_ORIGIN>/app`, a "Sign in with <email>" line with the plain link, and a "Not expecting this? You can ignore this email." footer |

When the workspace name can't be read, it falls back to "your team's
workspace". The sender address is left to the flow.

## Delivery semantics

Best effort. The person is already in the workspace by the time the email is
sent; a failed send (non-2xx from the webhook, or unreachable) is logged as a
warning and the invite still returns `201`. There is no retry; re-inviting
the same email sends it again.

## Flow URL

`MEMBER_INVITE_EMAIL` currently shares its flow URL with the deploy token,
Showcase and schedule-alert emails (they all take the same `to` / `subject`
/ `variables.content` shape). It should get its own flow once the invite
email needs its own sender, look or tracking.

## Join request email (same flow)

Sent to every Owner and Admin when someone asks to join through the
workspace's invite link (`services/inviteLinks.ts` `notifyAdmins`). Same
webhook and payload shape; the body comes from `src/lib/joinRequestEmail.ts`
and links to `${FRONTEND_ORIGIN}/app/people`. Subject: "Asha wants to join
Acme on Embarko". Sent once per new request, best effort.
