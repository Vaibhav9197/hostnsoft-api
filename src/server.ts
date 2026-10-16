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
    const server = app.listen(port, () => {
      logger.info(`hostnsoft-api listening on port ${port}`);
      // Tell pm2 we can serve (wait_ready). No-op outside pm2.
      process.send?.("ready");
    });

    // Graceful shutdown. pm2 sends SIGINT on reload/stop (SIGTERM from
    // docker/systemd); without a handler Node would exit at once, cutting
    // in-flight requests. Close the server and finish them. Redis and
    // Prisma are deliberately left open so background work (footer resync,
    // showcase mail, slug changes) can still use them; they keep the
    // process alive, so the timer below is what ends it. pm2 kill_timeout
    // must be longer. server-setup.md#zero-downtime
    const SHUTDOWN_GRACE_MS = 30000;
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`[server] ${signal} received: closing HTTP server, finishing in-flight work`);
      server.close(() => logger.info("[server] HTTP server closed"));
      setTimeout(() => {
        logger.info(`[server] grace period of ${SHUTDOWN_GRACE_MS / 1000}s over, exiting`);
        process.exit(0);
      }, SHUTDOWN_GRACE_MS).unref();
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  })
  .catch((err) => {
    logger.error("[server] failed to connect to Redis:", err);
    process.exit(1);
  });


// Side-effecting (setInterval) — deliberately kept out of createApp()
// itself, which stays a pure factory (also used directly by tests).
startDomainReverificationLoop();
startOrphanCleanupLoop();
