import { pool } from "@workspace/db";
import type { Server } from "node:http";
import app from "./app";
import { assertAuthConfigForEnv } from "./auth/tokens";
import { bootstrapProductionWarning } from "./routes/auth";
import { logger } from "./lib/logger";

// Fail-fast (hardening 6.3B.7): AUTH_DISABLED=true está prohibido en
// producción — aborta el startup antes de abrir el puerto en lugar de
// arrancar con la autenticación/autorización burlada.
assertAuthConfigForEnv();

// Hardening 6.3B.15: el bootstrap de admin es opt-in (AUTH_BOOTSTRAP_ENABLED
// ausente = deshabilitado). Si un despliegue lo habilita explícitamente en
// producción, dejar huella en el log de arranque (no está prohibido, pero sí
// desaconsejado: identidad fija con rol admin y token estático).
const bootstrapWarning = bootstrapProductionWarning();
if (bootstrapWarning) {
  logger.warn(bootstrapWarning);
}

// Replit always provides PORT. Outside Replit (local dev on Windows, macOS or
// Linux) we fall back to the documented default port so `pnpm run dev` works
// without extra environment setup.
const rawPort = process.env["PORT"] ?? "5000";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server: Server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Graceful shutdown: stop accepting new connections, drain the HTTP server,
// close the PostgreSQL pool and then exit. A watchdog force-exits if draining
// takes too long (e.g. an open keep-alive connection with 10s idle timeout).
const GRACEFUL_TIMEOUT_MS = 10_000;
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down gracefully");

  const watchdog = setTimeout(() => {
    logger.error("Graceful shutdown timed out; forcing exit");
    process.exit(1);
  }, GRACEFUL_TIMEOUT_MS);
  watchdog.unref();

  server.close((closeErr) => {
    void pool
      .end()
      .then(() => {
        clearTimeout(watchdog);
        logger.info("Shutdown complete");
        process.exit(closeErr ? 1 : 0);
      })
      .catch((poolErr) => {
        logger.error({ err: poolErr }, "Error closing database pool");
        process.exit(1);
      });
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
