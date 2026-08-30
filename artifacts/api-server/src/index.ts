import app from "./app";
import { logger } from "./lib/logger";

// Replit always provides PORT. Outside Replit (local dev on Windows, macOS or
// Linux) we fall back to the documented default port so `pnpm run dev` works
// without extra environment setup.
const rawPort = process.env["PORT"] ?? "5000";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
