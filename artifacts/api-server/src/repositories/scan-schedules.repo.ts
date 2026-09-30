import { and, asc, eq, exists, isNotNull, lte } from "drizzle-orm";
import {
  db,
  scanSchedulesTable,
  sourcesTable,
  type ScanSchedule,
} from "@workspace/db";
import { newId } from "./ids";
import { tenantScopeStrict, withTenant, setTenantLocal } from "./tenant";
import { bgDb } from "@workspace/db/background";

/**
 * M21.3 — EXISTS: el schedule pertenece al tenant activo vía su source (FK).
 * Sin JOIN para que `SELECT *` siga devolviendo la fila `scan_schedules`.
 */
function scheduleTenantExists(tenantId: string) {
  return exists(
    db
      .select({ id: sourcesTable.id })
      .from(sourcesTable)
      .where(
        and(
          eq(sourcesTable.id, scanSchedulesTable.sourceId),
          tenantScopeStrict(sourcesTable.tenantId, tenantId),
        ),
      ),
  );
}

/**
 * M10.3 — Repositorio de horarios de escaneo automático (`scan_schedules`).
 *
 * Decisiones de diseño (plan M10 aprobado):
 * - Una fila por fuente (índice único `scan_schedules_source_id_key`); sin
 *   fila = solo escaneo manual.
 * - `upsert` es transaccional y bloquea la fuente con `FOR UPDATE` para
 *   serializar frente a `DELETE /sources/{id}` (la FK CASCADE no borra la
 *   fila del schedule si insertamos después del delete de la fuente).
 * - `claimDue` es el núcleo anti doble-despacho: en UNA transacción reclama
 *   los vencidos con `FOR UPDATE SKIP LOCKED` y avanza `next_run_at` (y
 *   `last_run_at`) DENTRO de la misma transacción. Dos ticks (o dos
 *   instancias) nunca obtienen el mismo vencimiento: el segundo ve
 *   `next_run_at` ya en el futuro. Si el proceso muere tras el claim y antes
 *   de despachar, el resultado es "una corrida saltada", nunca duplicada.
 * - `markResult` es un statement único idempotente (patrón heartbeat): la
 *   condición vive en el WHERE y no hay transacción.
 * - `last_status` refleja el resultado del despacho (`ok | skipped | error`),
 *   no el estado del scan (ese vive en `scans.status`).
 *
 * Las reglas puras (rango del intervalo, cálculo de próxima corrida,
 * criterio de vencimiento y selección de reclamables) están extraídas a
 * funciones exportadas para poder testearlas con el patrón real del proyecto
 * (tests unitarios sin BD; el SQL queda cubierto por typecheck + la garantía
 * de los índices/constraints verificados en la migración 0009).
 */

export const SCAN_SCHEDULE_MIN_MINUTES = 15;
export const SCAN_SCHEDULE_MAX_MINUTES = 10080; // 7 días
/** Default cuando `enabled=false` y no se envía intervalo: diario. */
export const SCAN_SCHEDULE_DEFAULT_MINUTES = 1440;

export type NormalizeIntervalResult =
  | { ok: true; intervalMinutes: number }
  | { ok: false; reason: "missing_interval" | "interval_out_of_range" };

/**
 * Normaliza el intervalo del body del PUT (contrato `SourceScheduleUpdate`):
 * - `enabled=true` exige `intervalMinutes` dentro de [15, 10080].
 * - `enabled=false` lo acepta opcional (default diario); si viene, debe
 *   estar en rango para no persistir basura que luego fallaría al habilitar.
 */
export function normalizeIntervalMinutes(input: {
  enabled: boolean;
  intervalMinutes?: number;
}): NormalizeIntervalResult {
  const raw = input.intervalMinutes;
  if (raw === undefined) {
    if (input.enabled) {
      return { ok: false, reason: "missing_interval" };
    }
    return { ok: true, intervalMinutes: SCAN_SCHEDULE_DEFAULT_MINUTES };
  }
  if (
    !Number.isInteger(raw) ||
    raw < SCAN_SCHEDULE_MIN_MINUTES ||
    raw > SCAN_SCHEDULE_MAX_MINUTES
  ) {
    return { ok: false, reason: "interval_out_of_range" };
  }
  return { ok: true, intervalMinutes: raw };
}

/** Próxima corrida: `from + intervalMinutes` minutos. */
export function computeNextRun({
  intervalMinutes,
  from,
}: {
  intervalMinutes: number;
  from: Date;
}): Date {
  return new Date(from.getTime() + intervalMinutes * 60_000);
}

/**
 * Criterio de vencimiento: `enabled && nextRunAt != null && nextRunAt <= now`
 * (comparación estrictamente inclusiva en la frontera, mismo criterio que el
 * sweep del reaper: un vencimiento exactamente `now` está vencido).
 */
export function isDue(
  schedule: Pick<ScanSchedule, "enabled" | "nextRunAt">,
  now: Date,
): boolean {
  return (
    schedule.enabled === true &&
    schedule.nextRunAt !== null &&
    schedule.nextRunAt.getTime() <= now.getTime()
  );
}

/**
 * Selección pura de reclamables (segunda barrera del claim, defensa en
 * profundidad sobre el filtro SQL): filtra vencidos, ordena por
 * `next_run_at` ASC (el más atrasado primero, mismo orden que el índice
 * parcial) y respeta el límite de despachos por tick.
 */
export function selectDueSchedules(
  rows: ScanSchedule[],
  now: Date,
  limit: number,
): ScanSchedule[] {
  return rows
    .filter((row) => isDue(row, now))
    .sort(
      (a, b) =>
        (a.nextRunAt as Date).getTime() - (b.nextRunAt as Date).getTime(),
    )
    .slice(0, limit);
}

export type UpsertScheduleResult =
  | { ok: true; schedule: ScanSchedule }
  | {
      ok: false;
      reason: "source_not_found" | "invalid_interval";
    };

/**
 * Crea o actualiza (idempotente) el horario de una fuente. La garantía de
 * "una fila por fuente" la da el índice único + `ON CONFLICT DO UPDATE`;
 * el update NO toca `last_run_at`/`last_status`/`last_error` (historial del
 * despacho anterior). Al guardar siempre se reprograma desde `at`
 * (habilitar = primera corrida en `at + intervalo`; cambiar intervalo =
 * reprogramar desde ahora).
 */
export async function upsert(
  input: {
    sourceId: string;
    enabled: boolean;
    intervalMinutes?: number;
    at: Date;
  },
  tenantId: string,
): Promise<UpsertScheduleResult> {
  const normalized = normalizeIntervalMinutes({
    enabled: input.enabled,
    intervalMinutes: input.intervalMinutes,
  });
  if (!normalized.ok) return { ok: false, reason: "invalid_interval" as const };

  return db.transaction(async (tx) => {
    // M21.8 — tenant context transaccional (RLS).
    await setTenantLocal(tx, tenantId);

    const [source] = await tx
      .select({ id: sourcesTable.id })
      .from(sourcesTable)
      // M21.3 — scoping por tenant (D2): fuente ajena → source_not_found.
      .where(
        and(
          eq(sourcesTable.id, input.sourceId),
          tenantScopeStrict(sourcesTable.tenantId, tenantId),
        ),
      )
      .for("update");
    if (!source) return { ok: false, reason: "source_not_found" as const };

    const nextRunAt = input.enabled
      ? computeNextRun({ intervalMinutes: normalized.intervalMinutes, from: input.at })
      : null;

    const [row] = await tx
      .insert(scanSchedulesTable)
      .values({
        id: newId("sched"),
        sourceId: input.sourceId,
        enabled: input.enabled,
        intervalMinutes: normalized.intervalMinutes,
        nextRunAt,
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        createdAt: input.at,
        updatedAt: input.at,
      })
      .onConflictDoUpdate({
        target: scanSchedulesTable.sourceId,
        set: {
          enabled: input.enabled,
          intervalMinutes: normalized.intervalMinutes,
          nextRunAt,
          updatedAt: input.at,
        },
      })
      .returning();

    return { ok: true, schedule: row };
  });
}

/** Horario de una fuente (null si la fuente no tiene fila de schedule o es ajena). */
export async function getBySourceId(
  sourceId: string,
  tenantId: string,
): Promise<ScanSchedule | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(scanSchedulesTable)
      .where(
        and(
          eq(scanSchedulesTable.sourceId, sourceId),
          // M21.3 — scoping vía source (D2).
          scheduleTenantExists(tenantId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export type ClaimedSchedule = { schedule: ScanSchedule };

/**
 * Reclama los horarios vencidos (máximo `limit` por tick). El avance de
 * `next_run_at` ocurre DENTRO de la transacción, con `FOR UPDATE SKIP
 * LOCKED`: concurrente o secuencialmente, cada vencimiento se entrega una
 * sola vez. El resultado se devuelve al final para que el llamador (M10.4)
 * despache FUERA de la transacción.
 */
export async function claimDue({
  now,
  limit,
}: {
  now: Date;
  limit: number;
}): Promise<ClaimedSchedule[]> {
  return bgDb().transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(scanSchedulesTable)
      .where(
        and(
          eq(scanSchedulesTable.enabled, true),
          isNotNull(scanSchedulesTable.nextRunAt),
          lte(scanSchedulesTable.nextRunAt, now),
        ),
      )
      .orderBy(asc(scanSchedulesTable.nextRunAt))
      .limit(limit)
      .for("update", { skipLocked: true });

    const due = selectDueSchedules(candidates, now, limit);

    const claimed: ClaimedSchedule[] = [];
    for (const row of due) {
      const [updated] = await tx
        .update(scanSchedulesTable)
        .set({
          nextRunAt: computeNextRun({
            intervalMinutes: row.intervalMinutes,
            from: now,
          }),
          lastRunAt: now,
          updatedAt: now,
        })
        .where(eq(scanSchedulesTable.id, row.id))
        .returning();
      claimed.push({ schedule: updated });
    }
    return claimed;
  });
}

/**
 * Registra el resultado del despacho (statement único, idempotente, patrón
 * heartbeat: sin transacción; `last_status`/`last_error` solo describen el
 * último despacho).
 */
export async function markResult(input: {
  id: string;
  status: "ok" | "skipped" | "error";
  error?: string | null;
  at: Date;
}): Promise<void> {
  await bgDb()
    .update(scanSchedulesTable)
    .set({
      lastStatus: input.status,
      lastError: input.error ?? null,
      updatedAt: input.at,
    })
    .where(eq(scanSchedulesTable.id, input.id));
}
