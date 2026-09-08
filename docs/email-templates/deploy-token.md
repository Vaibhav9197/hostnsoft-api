# Deploy token email (viasocket flow)

Sent from the public endpoint `POST /public/deploy-tokens/request`. The API
does not talk to a mail provider directly: `src/services/publicTokenRequest.ts`
POSTs the payload below to the viasocket webhook `Webhook.DEPLOY_TOKEN_EMAIL`
(URL constant in `src/lib/webhooks.ts`), and the viasocket flow sends the
email through MSG91.

The email body is rendered **in this API** (`src/lib/deployTokenEmail.ts`)
because the number of companies varies per recipient, which MSG91 template
variables can't loop over. The flow's MSG91 template therefore needs exactly
one variable, `content`, placed where the body goes.

## Payload

```json
{
  "to": [{ "email": "rita@example.com" }],
  "subject": "Your Embarko AI deploy tokens",
  "variables": {
    "content": "<table role=\"presentation\" …>…</table>"
  }
}
```

| Field | Meaning |
|---|---|
| `to[0].email` | Recipient (normalised: trimmed, lowercased) |
| `subject` | Singular or plural depending on the number of companies |
| `variables.content` | Email-safe HTML (tables, inline styles, no external assets): a company → token table, a note that existing tokens are unaffected, a dashboard link, and an "ignore if not you" footer |

The sender address is left to the flow.

A non-2xx response from the webhook is logged by the API and the caller
still receives the generic 202 (the response must not reveal delivery
outcome). The tokens were already minted in that case (unused rows, harmless); the next request
mints again.
