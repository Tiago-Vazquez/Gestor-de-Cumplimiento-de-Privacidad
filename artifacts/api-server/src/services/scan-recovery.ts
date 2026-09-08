import { repos } from "../repositories";
import { logger } from "../lib/logger";
import type { Scan } from "@workspace/db";

/**
 * Recuperación de scans huérfanos (FASE 7.0.4).
 *
 * Un scan puede quedar permanentemente en `running` si el proceso muere a
 * mitad de ejecución (crash, reinicio, OOM) o si el propio `failScan` falló
 * (residual de 7.0.2). Sin reaper, el dashboard quedaría en "scanning" para
 * siempre y el historial mostraría un scan vivo que no existe.
 *
 * Estrategia (instancia única, MVP):
 * - Arranque: todo scan `running` anterior a `bootStartedAt` es huérfano —
 *   al nacer el proceso no puede haber scans legítimos en ejecución. El
 *   límite lo captura `index.ts` ANTES de abrir el puerto para que un
 *   POST /scans recibido durante el recovery de arranque nunca sea marcado.
 * - Periódico: scans `running` cuyo último signo de vida (`heartbeat_at`,
 *   con fallback a `started_at` para scans legacy) es anterior a `now - TTL`.
 *
 * FASE 7.1.0 (M0): con el heartbeat del scanner el TTL baja de 60 a 10 minutos
 * (latido por defecto cada 10 s ⇒ margen ×60) y es configurable vía
 * `SCAN_RUNNING_TTL_MS` (clamp [1 min, 24 h]). El fallback a `started_at`
 * preserva íntegro el criterio de 7.0.4 para scans sin latido.
 *
 * Ambos sweeps son best-effort: capturan sus errores (solo logging, sin
 * credenciales ni connectionConfig) y jamás lanzan ni tumban el servidor.
 */

export const SCAN_RUNNING_TTL_MS = 10 * 60_000;
export const SCAN_REAPER_INTERVAL_MS = 5 * 60_000;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;

/** TTL efectivo del sweep periódico (env SCAN_RUNNING_TTL_MS, clamp seguro). */
export function scanStaleTtlMs(): number {
  const raw = process.env.SCAN_RUNNING_TTL_MS;
  if (raw === undefined || raw.trim() === "") return SCAN_RUNNING_TTL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return SCAN_RUNNING_TTL_MS;
  return Math.min(Math.max(value, MIN_TTL_MS), MAX_TTL_MS);
}

/** Nunca lanza: registra el error y devuelve [] para no tumbar el arranque. */
async function failRunningScans(before: Date, sweep: string): Promise<Scan[]> {
  try {
    return await repos.scans.failStaleRunningScans({
      before,
      completedAt: new Date(),
      reason: "timeout",
    });
  } catch (error) {
    logger.error({ err: error, sweep }, "Scan recovery failed");
    return [];
  }
}

/** Sweep de arranque: recupera los `running` previos a `bootStartedAt`. */
export async function recoverOrphanedScansAtBoot(bootStartedAt: Date): Promise<Scan[]> {
  const recovered = await failRunningScans(bootStartedAt, "boot");
  if (recovered.length > 0) {
    logger.warn(
      { recovered: recovered.length },
      "Recovered orphaned scans (running when this process started)",
    );
  }
  return recovered;
}

/** Sweep periódico: recupera los `running` con último latido más viejo que el TTL. */
export async function recoverStaleRunningScans(now: Date = new Date()): Promise<Scan[]> {
  const before = new Date(now.getTime() - scanStaleTtlMs());
  const recovered = await failRunningScans(before, "periodic");
  if (recovered.length > 0) {
    logger.warn({ recovered: recovered.length }, "Recovered stale running scans");
  }
  return recovered;
}