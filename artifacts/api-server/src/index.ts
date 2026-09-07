import { pool } from "@workspace/db";
import type { Server } from "node:http";
import app from "./app";
import { assertAuthConfigForEnv } from "./auth/tokens";
import { assertSourceEncryptionKeyForEnv } from "./lib/secret-manager";
import { bootstrapProductionWarning } from "./routes/auth";
import { logger } from "./lib/logger";
import {
  recoverOrphanedScansAtBoot,
  recoverStaleRunningScans,
  SCAN_REAPER_INTERVAL_MS,
} from "./services/scan-recovery";

// Fail-fast (hardening 6.3B.7): AUTH_DISABLED=true está prohibido en
// producción — aborta el startup antes de abrir el puerto en lugar de
// arrancar con la autenticación/autorización burlada.
assertAuthConfigForEnv();

// FASE 7.0.5 (M9): fail-fast para SOURCE_ENCRYPTION_KEY en producción.
// En development/test, si falta la clave se emite un warning y se continúa.
assertSourceEncryptionKeyForEnv();

// Hardening 6.3B.15: el bootstrap de admin es opt-in (AUTH_BOOTSTRAP_ENABLED
// ausente = deshabilitado). Si un despliegue lo habilita explícitamente en
// producción, dejar huella en el log de arranque (no está prohibido, pero sí
// desaconsejado: identidad fija con rol admin y token estático).
const bootstrapWarning = bootstrapProductionWarning();
if (bootstrapWarning) {
  logger.warn(bootstrapWarning);
}

// FASE 7.0.4: timestamp de inicio del proceso, capturado ANTES de abrir el
// puerto. El sweep de arranque lo usa como límite (`before = bootStartedAt`):
// solo recupera scans que ya estaban `running` cuando este proceso nació, de
// modo que un POST /scans legítimo recibido durante el recovery de arranque
// nunca puede ser marcado como failed(timeout) por error.
const bootStartedAt = new Date();

// FASE 7.0.4: guard de concurrencia del reaper — si un barrido sigue en curso
// no se inicia otro; se espera al siguiente intervalo.
let recoveryInProgress = false;

async function runScanRecoverySafely(sweep: () => Promise<unknown>, sweepLabel: string): Promise<void> {
  if (recoveryInProgress) {
    logger.debug({ sweep: sweepLabel }, "Scan recovery already in progress; skipping this tick");
    return;
  }
  recoveryInProgress = true;
  try {
    await sweep();
  } catch (error) {
    // Defensa en profundidad: los sweeps ya capturan sus errores internamente;
    // esto evita cualquier unhandled rejection que tumbe el proceso.
    logger.error({ err: error, sweep: sweepLabel }, "Unexpected scan recovery error");
  } finally {
    recoveryInProgress = false;
  }
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

  // FASE 7.0.4: recuperar los scans que quedaron `running` de una ejecución
  // anterior (crash/reinicio). Best-effort: nunca tumba el arranque.
  void runScanRecoverySafely(() => recoverOrphanedScansAtBoot(bootStartedAt), "boot");
});

// FASE 7.0.4: barrido periódico — recupera los `running` que exceden el TTL
// (p. ej. un failScan que falló en un proceso vivo). `unref()` para no impedir
// el shutdown, igual que el watchdog de abajo.
const scanReaperTimer = setInterval(() => {
  void runScanRecoverySafely(() => recoverStaleRunningScans(), "periodic");
}, SCAN_REAPER_INTERVAL_MS);
scanReaperTimer.unref();

// Graceful shutdown: stop accepting new connections, drain the HTTP server,
// close the PostgreSQL pool and then exit. A watchdog force-exits if draining
// takes too long (e.g. an open keep-alive connection with 10s idle timeout).
const GRACEFUL_TIMEOUT_MS = 10_000;
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down gracefully");

  // FASE 7.0.4: detener el reaper antes de drenar el servidor.
  clearInterval(scanReaperTimer);

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
