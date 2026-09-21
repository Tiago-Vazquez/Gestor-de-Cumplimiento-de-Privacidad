import { repos } from "../repositories";
import { logger } from "../lib/logger";
import { schedulerDispatchTotal, schedulerErrorsTotal } from "../lib/metrics";
import { runScan } from "./scanner";
import { recordAuditEvent } from "../lib/audit";

/**
 * M10.4 — Servicio scheduler de escaneos automáticos.
 *
 * Ejecuta periódicamente `runSchedulerTick`, que reclama los horarios
 * vencidos vía `repos.scanSchedules.claimDue` (transaccional, SKIP LOCKED)
 * y despacha cada uno por el MISMO pipeline que los scans manuales
 * (`repos.scans.startScan` + `runScan`). No hay un segundo pipeline.
 *
 * Concurrencia:
 * - Dentro del proceso: guard `tickInProgress` — si un tick sigue en curso no
 *   se inicia otro (mismo patrón que el reaper en `index.ts`).
 * - Entre procesos/instancias: lo garantiza `claimDue` (el avance de
 *   `next_run_at` ocurre DENTRO de la transacción), no este servicio.
 *
 * Downtime / catch-up: `claimDue` avanza `next_run_at` desde `now` en un solo
 * paso, de modo que un horario atrasado produce como máximo UN despacho por
 * tick y queda programado hacia el futuro. No hay compensación de corridas
 * perdidas (sin catch-up storm).
 *
 * El scheduler es best-effort: captura sus errores (solo logging) y jamás
 * lanza ni tumba el servidor.
 */

export const SCAN_SCHEDULER_TICK_MS = 60_000;
export const SCAN_SCHEDULER_BATCH = 5;
const MIN_TICK_MS = 10_000;
const MAX_TICK_MS = 60 * 60_000;
const MIN_BATCH = 1;
const MAX_BATCH = 50;

/** Intervalo efectivo del timer (env SCAN_SCHEDULER_TICK_MS, clamp seguro). */
export function scanSchedulerTickMs(): number {
  const raw = process.env.SCAN_SCHEDULER_TICK_MS;
  if (raw === undefined || raw.trim() === "") return SCAN_SCHEDULER_TICK_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return SCAN_SCHEDULER_TICK_MS;
  return Math.min(Math.max(value, MIN_TICK_MS), MAX_TICK_MS);
}

/** Máximo de horarios despachados por tick (env SCAN_SCHEDULER_BATCH). */
export function scanSchedulerBatch(): number {
  const raw = process.env.SCAN_SCHEDULER_BATCH;
  if (raw === undefined || raw.trim() === "") return SCAN_SCHEDULER_BATCH;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return SCAN_SCHEDULER_BATCH;
  return Math.min(Math.max(Math.trunc(value), MIN_BATCH), MAX_BATCH);
}

export type SchedulerTickSummary = {
  claimed: number;
  dispatched: number;
  skipped: number;
  failed: number;
};

/**
 * Un tick del scheduler: reclama los vencidos y los despacha fuera de la
 * transacción. Nunca lanza: cada despacho captura su propio error y el
 * resultado queda registrado con `markResult`.
 */
export async function runSchedulerTick(now: Date = new Date()): Promise<SchedulerTickSummary> {
  const summary: SchedulerTickSummary = { claimed: 0, dispatched: 0, skipped: 0, failed: 0 };

  const claimed = await repos.scanSchedules.claimDue({ now, limit: scanSchedulerBatch() });
  summary.claimed = claimed.length;

  for (const { schedule } of claimed) {
    try {
      const result = await repos.scans.startScan({
        sourceId: schedule.sourceId,
        startedAt: now,
      });
      if (!result.ok) {
        // La fuente ya tiene un scan en curso (o fue eliminada): el
        // vencimiento ya fue consumido por el claim → "corrida saltada".
        summary.skipped += 1;
        // M16.3 — evento de ciclo de vida del scheduler (sin scanId: no llegó
        // a crearse el scan).
        logger.info(
          { event: "scheduler_skipped", scheduleId: schedule.id, sourceId: schedule.sourceId, reason: result.reason },
          "Scheduled scan skipped (source busy or missing)",
        );
        await repos.scanSchedules.markResult({ id: schedule.id, status: "skipped", at: now });
        continue;
      }

      // Mismo pipeline que POST /scans: el scan corre en background y los
      // errores del escaneo se registran en `scans` (runScan garantiza el
      // estado terminal); aquí solo se registra el resultado del despacho.
      summary.dispatched += 1;
      // M16.3 — despacho aceptado: evento + métrica. El ciclo de vida del scan
      // en sí (started/completed/failed) lo registra el scanner.
      schedulerDispatchTotal.inc();
      logger.info(
        { event: "scheduler_dispatch", scanId: result.scan.id, sourceId: schedule.sourceId, intervalMinutes: schedule.intervalMinutes },
        "Scheduled scan dispatched to the standard pipeline",
      );
      await repos.scanSchedules.markResult({ id: schedule.id, status: "ok", at: now });

      // M17 — escaneo disparado por el scheduler: no hay usuario humano, así
      // que `actor_user_id` queda null y el origen se marca en metadata
      // (`origin: "scheduler"`). Mismo vocabulario de acción que el manual.
      await recordAuditEvent({
        actorUserId: null,
        action: "scan_started",
        resourceType: "scan",
        resourceId: result.scan.id,
        result: "success",
        origin: "scheduler",
        metadata: {
          sourceId: schedule.sourceId,
          scheduleId: schedule.id,
          intervalMinutes: schedule.intervalMinutes,
          trigger: "scheduler",
        },
      });

      void runScan({ scanId: result.scan.id, sourceId: schedule.sourceId }).catch((error) => {
        logger.error({ err: error, scanId: result.scan.id }, "Scheduled scan crashed");
      });
    } catch (error) {
      // Fallo del despacho (p. ej. startScan lanzó por BD): queda registrado
      // y NO detiene el resto del tick ni el scheduler.
      summary.failed += 1;
      schedulerErrorsTotal.inc();
      logger.error(
        { event: "scheduler_error", err: error, scheduleId: schedule.id, sourceId: schedule.sourceId },
        "Scheduled scan dispatch failed",
      );
      try {
        await repos.scanSchedules.markResult({
          id: schedule.id,
          status: "error",
          error: error instanceof Error ? error.message : "dispatch_failed",
          at: now,
        });
      } catch (markError) {
        logger.error({ err: markError, scheduleId: schedule.id }, "Failed to record dispatch error");
      }

      // M17 — el despacho falló: se audita el INTENTO (scan_started/failure)
      // con el origen scheduler. No se persiste el mensaje del error: puede
      // contener detalles de conexión (credenciales incluidas).
      await recordAuditEvent({
        actorUserId: null,
        action: "scan_started",
        resourceType: "scan",
        result: "failure",
        origin: "scheduler",
        metadata: {
          sourceId: schedule.sourceId,
          scheduleId: schedule.id,
          trigger: "scheduler",
          reason: "dispatch_error",
        },
      });
    }
  }

  return summary;
}

// Instancia única del timer por proceso (null = no iniciado).
let schedulerTimer: NodeJS.Timeout | null = null;
// Guard contra ticks solapados dentro del mismo proceso.
let tickInProgress = false;

/** Wrapper best-effort de un tick: nunca lanza ni deja la guardia colgada. */
export async function runSchedulerTickSafely(): Promise<void> {
  if (tickInProgress) {
    logger.debug("Scan scheduler tick already in progress; skipping this tick");
    return;
  }
  tickInProgress = true;
  try {
    await runSchedulerTick();
  } catch (error) {
    logger.error({ err: error }, "Unexpected scan scheduler error");
  } finally {
    tickInProgress = false;
  }
}

/**
 * Inicia el timer periódico del scheduler (una única instancia por proceso;
 * llamar de nuevo es un no-op). `unref()` para no impedir el shutdown.
 */
export function startScanScheduler(): void {
  if (schedulerTimer !== null) return;
  schedulerTimer = setInterval(() => {
    void runSchedulerTickSafely();
  }, scanSchedulerTickMs());
  schedulerTimer.unref();
  logger.info({ tickMs: scanSchedulerTickMs(), batch: scanSchedulerBatch() }, "Scan scheduler started");
}

/** Detiene el timer del scheduler (idempotente; no deja timers activos). */
export function stopScanScheduler(): void {
  if (schedulerTimer === null) return;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
  logger.info("Scan scheduler stopped");
}

/** M16.5 — estado del scheduler para los health probes (sin secretos). */
export function isScanSchedulerRunning(): boolean {
  return schedulerTimer !== null;
}