// Shared by app.ts (CORS) and auth.routes.ts (the msg91 redirect callback)
// so the two never drift on what "the frontend" means.
export const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
