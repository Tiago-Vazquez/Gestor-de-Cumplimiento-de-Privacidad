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
 * - Periódico: scans `running` con `startedAt` anterior a `now - TTL`;
 *   reintenta además los casos donde `failScan` falló en un proceso vivo.
 *
 * El TTL es deliberadamente alto: sin columna de heartbeat/updated_at el
 * único criterio es `startedAt`, y un TTL corto podría matar scans legítimos
 * lentos. Tradeoff documentado; la solución definitiva exige heartbeat.
 *
 * Ambos sweeps son best-effort: capturan sus errores (solo logging, sin
 * credenciales ni connectionConfig) y jamás lanzan ni tumban el servidor.
 */

export const SCAN_RUNNING_TTL_MS = 60 * 60_000;
export const SCAN_REAPER_INTERVAL_MS = 5 * 60_000;

/** Nunca lanza: registra el error y devuelve [] para no tumbar el arranque. */
async function failRunningScans(before: Date, sweep: string): Promise<Scan[]> {
  try {
    return await repos.scans.failRunningScansStartedBefore({
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

/** Sweep periódico: recupera los `running` más viejos que el TTL. */
export async function recoverStaleRunningScans(now: Date = new Date()): Promise<Scan[]> {
  const before = new Date(now.getTime() - SCAN_RUNNING_TTL_MS);
  const recovered = await failRunningScans(before, "periodic");
  if (recovered.length > 0) {
    logger.warn({ recovered: recovered.length }, "Recovered stale running scans");
  }
  return recovered;
}