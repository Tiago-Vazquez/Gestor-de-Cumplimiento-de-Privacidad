import { logger } from "../lib/logger";
import { numberFromEnv } from "../lib/env";
import { repos } from "../repositories";

/**
 * M18 Fase 3 — retención de sesiones cerradas/expiradas antes de purgar.
 * Default 30 días (2 592 000 s); mínimo 1 h para no borrar por accidente con
 * un valor mal configurado.
 */
export function sessionRetentionSeconds(): number {
  const value = numberFromEnv("SESSION_RETENTION_SECONDS", 2_592_000);
  return value >= 3_600 ? value : 2_592_000;
}

/** Tick del sweep (default 1 h, clamp 10 s–24 h). */
export function sessionCleanupTickMs(): number {
  const value = numberFromEnv("SESSION_CLEANUP_TICK_MS", 3_600_000);
  return value >= 10_000 && value <= 86_400_000 ? value : 3_600_000;
}

let cleanupInProgress = false;

/**
 * M18 Fase 3 — barrido de sesiones huérfanas y contadores vencidos:
 * - sesiones con `expires_at` anterior al corte (expiradas) o revocadas más
 *   antiguas que la retención, se eliminan (la tabla crece sin límite hoy);
 * - contadores de rate limiting vencidos (`rate_limit_hits`).
 * Nunca lanza: los errores técnicos ya los cubre el logging de M16.
 */
export async function runSessionCleanupSafely(): Promise<void> {
  if (cleanupInProgress) {
    return;
  }
  cleanupInProgress = true;
  try {
    const cutoff = new Date(Date.now() - sessionRetentionSeconds() * 1000);
    const [sessions, counters] = await Promise.all([
      repos.sessions.cleanupStale(cutoff),
      repos.rateLimits.cleanupExpired(),
    ]);
    if (sessions > 0 || counters > 0) {
      logger.info(
        { sessions, counters },
        "Session cleanup sweep completed",
      );
    }
  } catch (error) {
    logger.error({ err: error }, "Unexpected session cleanup error");
  } finally {
    cleanupInProgress = false;
  }
}

/** Inicia el barrido periódico (mismo patrón `unref()` del reaper de scans). */
export function startSessionCleanup(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void runSessionCleanupSafely();
  }, sessionCleanupTickMs());
  timer.unref();
  logger.info(
    {
      tickMs: sessionCleanupTickMs(),
      retentionSeconds: sessionRetentionSeconds(),
    },
    "Session cleanup sweep started",
  );
  return timer;
}
