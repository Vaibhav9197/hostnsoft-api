import "dotenv/config";
import { createApp } from "./app";
import { logger } from "./lib/logger";
import { startDomainReverificationLoop } from "./services/domainReverification";

const port = Number(process.env.PORT ?? 4100);
const app = createApp();

app.listen(port, () => {
  logger.info(`hostnsoft-api listening on port ${port}`);
});

// Side-effecting (setInterval) — deliberately kept out of createApp()
// itself, which stays a pure factory (also used directly by tests).
startDomainReverificationLoop();
