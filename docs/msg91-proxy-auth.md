# API — MSG91 Proxy Auth

> This document explains how the MSG91 proxy-auth service works and how to integrate the same pattern in a different API-only product.

## Purpose

MSG91 proxy auth is a hosted authentication flow where MSG91 owns the login / registration / forgot-password UI and issues a single, verified identity token back to your app. Your backend then verifies that token against MSG91 and creates or links a user in your own system.

This pattern is useful when you want:

- a consistent authentication UX without building login screens yourself
- a managed identity flow for login, signup, and password recovery
- a backend that still owns the final session, JWT, or cookie issuance

In this codebase, the flow is implemented as:

- widget loads from `https://proxy.msg91.com/assets/proxy-auth/proxy-auth.js`
- successful verification returns a `proxy_auth_token`
- server calls `https://routes.msg91.com/api/c/getDetails`
- the backend creates or updates a local user and sets its own app session

---

## How the service works

### 1. Client loads the MSG91 widget

The client mounts the MSG91 verification widget using a `referenceId` and a `type` such as `authorization`.

```html
<div id="MSG91_PROXY_REF"></div>
<script src="https://proxy.msg91.com/assets/proxy-auth/proxy-auth.js"></script>
```

The widget is initialized with a config similar to:

```ts
window.initVerification({
  referenceId: "<reference-id>",
  type: "authorization",
  addInfo: { redirect_path: "https://api.example.com/auth/callback" },
  success: (data) => {
    const token = data?.token || data?.proxy_auth_token || data?.authToken || data?.access_token;
    // send token to your backend
  },
  failure: (error) => {
    console.error("MSG91 auth failed", error);
  },
});
```

### 2. The widget returns a token

After successful verification, MSG91 gives the client a token.

It may come as:

- `token`
- `proxy_auth_token`
- `authToken`
- `access_token`

This token is not enough by itself to trust the user. The app must validate it with MSG91 before creating a session.

### 3. Backend verifies the token with MSG91

The backend sends the token to MSG91 as an HTTP header:

```http
GET https://routes.msg91.com/api/c/getDetails
proxy_auth_token: <token>
```

A successful response contains the verified identity in a nested payload such as:

```json
{
  "data": [
    {
      "id": "12345",
      "name": "Rita Sharma",
      "email": "rita@example.com",
      "meta": {
        "email": "rita@example.com",
        "type": "embed"
      },
      "currentCompany": {
        "id": "company-1",
        "name": "Acme Inc"
      }
    }
  ]
}
```

In this codebase, the verification helper normalizes this into a shape like:

```ts
interface Msg91Identity {
  id: string;
  name: string;
  email: string | null;
  meta: Record<string, any>;
  isEmbedUser: boolean;
  folderId: string | null;
  org: { id: string | null; name: string | null };
}
```

### 4. Backend creates or links the local user

Once the token is validated, the backend should:

- upsert the user by `msg91Id` if present
- link an existing local account by email when applicable
- store normalized identity data
- issue the product's own session / JWT / cookie

Example logic:

```ts
const token = req.body.token;
const res = await fetch("https://routes.msg91.com/api/c/getDetails", {
  headers: { proxy_auth_token: token },
  cache: "no-store",
});

if (!res.ok) throw new Error("Invalid proxy token");

const body = await res.json();
const record = body?.data?.[0];
if (!record?.id) throw new Error("No identity returned");

const user = await upsertUser({
  msg91Id: String(record.id),
  email: record.email || record.meta?.email || `${record.id}@msg91.proxy`,
  name: record.name || record.meta?.name || "MSG91 User",
});

const session = await createSessionFor(user);
return respondWithSession(session);
```

---

## Recommended flow for an API-only product

For an API-only app, keep the client thin and move all trust checks to the backend.

### Option A: callback flow (recommended for browser-based apps)

1. Client loads MSG91 widget.
2. User completes auth in MSG91.
3. MSG91 redirects back to your app with `proxy_auth_token` in the URL.
4. Your backend receives the token and verifies it via `getDetails`.
5. Your backend creates the user and issues your own session cookie/JWT.
6. Your backend redirects the user onward.

This pattern is used in this repo's redirect flow:

```ts
GET /api/auth/proxy?proxy_auth_token=...&next=/dashboard
```

The backend validates the token and issues the app session server-side, rather than trusting the browser.

### Option B: token exchange flow (best for pure API clients)

1. Client receives `proxy_auth_token` from the widget callback.
2. Client sends `{ token }` to your backend endpoint, e.g. `/api/auth/msg91/exchange`.
3. Backend verifies with MSG91.
4. Backend creates or links the local user.
5. Backend returns your own application token, cookie, or user payload.

```http
POST /api/auth/msg91/exchange
Content-Type: application/json

{
  "token": "<proxy_auth_token>"
}
```

```json
{
  "user": {
    "id": "u_123",
    "email": "rita@example.com",
    "name": "Rita Sharma"
  },
  "token": "<app_session_jwt>"
}
```

---

## Backend contract to implement

### Endpoint: POST /api/auth/msg91/exchange

#### Request

```json
{
  "token": "string"
}
```

#### Server behavior

- require a non-empty `token`
- call `https://routes.msg91.com/api/c/getDetails` with `proxy_auth_token: token`
- if the response is not ok, return `401 Unauthorized`
- parse `body.data[0]`
- if no valid identity is returned, return `401 Unauthorized`
- upsert user keyed by `msg91Id`
- issue the product's own session token
- return a sanitized user object and app token/cookie

#### Success response

```json
{
  "user": {
    "id": "u_123",
    "name": "Rita Sharma",
    "email": "rita@example.com"
  },
  "token": "app-session-jwt"
}
```

#### Failure response

```json
{
  "error": "Authentication failed"
}
```

---

## Security notes

- never trust the token until you validate it with MSG91
- verify the token server-side; do not trust browser-only state
- use HTTPS everywhere
- restrict redirect targets to an allowlist if you use the redirect flow
- create a local record keyed by `msg91Id` to avoid duplicates
- store only the normalized identity you need; avoid persisting the raw token unless absolutely required
- treat the token as a short-lived authentication artifact and do not reuse it beyond the exchange

---

## Recommended data model for your own product

A minimal user record for this integration looks like:

```ts
{
  id: "u_123",
  email: "rita@example.com",
  name: "Rita Sharma",
  authProvider: "msg91",
  msg91Id: "12345",
  active: true,
  createdAt: "2026-08-25T00:00:00.000Z"
}
```

This lets you:

- know the user came from MSG91
- prevent duplicate accounts
- map multiple auth events to the same local user
- keep your own app session separate from MSG91-specific state

---

## Example implementation pattern

### Node.js / Express-like pseudocode

```ts
app.post("/api/auth/msg91/exchange", async (req, res) => {
  const token = req.body.token;
  if (!token) return res.status(400).json({ error: "Missing token" });

  const msg91Res = await fetch("https://routes.msg91.com/api/c/getDetails", {
    headers: { proxy_auth_token: token },
    cache: "no-store",
  });

  if (!msg91Res.ok) {
    return res.status(401).json({ error: "Authentication failed" });
  }

  const body = await msg91Res.json();
  const record = body?.data?.[0];
  if (!record?.id) {
    return res.status(401).json({ error: "Authentication failed" });
  }

  const user = await upsertUser({
    msg91Id: String(record.id),
    email: record.email || record.meta?.email || `${record.id}@msg91.proxy`,
    name: record.name || record.meta?.name || "MSG91 User",
  });

  const appToken = await issueAppSession(user);
  return res.json({ user: sanitizeUser(user), token: appToken });
});
```

---

## Summary

MSG91 proxy auth is best thought of as an identity provider widget plus a server-side verification step. The real security boundary is not the widget itself, but the backend call to `getDetails` that confirms the token belongs to a real authenticated user.

For a separate API-only product, the correct architecture is:

1. embed MSG91 widget in the client
2. receive `proxy_auth_token`
3. validate it on the server via MSG91
4. create or link a local user
5. mint your product's own auth token or session

This keeps MSG91 in charge of the authentication UX while your product remains in charge of authorization and business logic.
