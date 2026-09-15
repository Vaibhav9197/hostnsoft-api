import type { DeployToken, Project } from "@prisma/client";
import type { Msg91Identity } from "../lib/msg91";

declare global {
  namespace Express {
    interface Request {
      // Proxy user id, from the verified PAT (src/middleware/proxyToken.ts).
      userId?: string;
      // Proxy company id from the URL, confirmed as one the caller belongs
      // to (src/middleware/companyContext.ts). Only the id is carried —
      // there is no local Company row, and nothing downstream needs more.
      company?: { id: string };
      project?: Project;
      // Set by src/middleware/proxyToken.ts on routes that act AS the user
      // against proxy (company list, switch, /auth/me). Never persisted.
      proxyAuthToken?: string;
      proxyIdentity?: Msg91Identity;
      // The validated deploy token behind an agent-authenticated request
      // (src/middleware/deployTokenContext.ts). Present only on the agent
      // routes; the dashboard's own routes never set it.
      deployToken?: DeployToken;
    }
  }
}
