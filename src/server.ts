import "dotenv/config";
import { createApp } from "./app";
import { connectRedis } from "./lib/redis";
import { logger } from "./lib/logger";
import { startDomainReverificationLoop } from "./services/domainReverification";
import { startOrphanCleanupLoop } from "./services/orphanCleanup";

const port = Number(process.env.PORT ?? 4100);
const app = createApp();

connectRedis()
  .then(() => {
    app.listen(port, () => {
      logger.info(`hostnsoft-api listening on port ${port}`);
    });
  })
  .catch((err) => {
    logger.error("[server] failed to connect to Redis:", err);
    process.exit(1);
  });


// Side-effecting (setInterval) — deliberately kept out of createApp()
// itself, which stays a pure factory (also used directly by tests).
startDomainReverificationLoop();
startOrphanCleanupLoop();
