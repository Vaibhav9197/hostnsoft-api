import "dotenv/config";
import { createApp } from "./app";
import { logger } from "./lib/logger";

const port = Number(process.env.PORT ?? 4100);
const app = createApp();

app.listen(port, () => {
  logger.info(`hostnsoft-api listening on port ${port}`);
});
