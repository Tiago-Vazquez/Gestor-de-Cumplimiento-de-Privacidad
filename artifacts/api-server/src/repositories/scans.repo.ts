import { and, desc, eq, sql } from "drizzle-orm";
import {
  activityTable,
  db,
  findingsTable,
  rulesTable,
  scansTable,
  sourcesTable,
  type Scan,
} from "@workspace/db";
import { newId } from "./ids";
import type { Pagination } from "../lib/pagination";

export type StartScanResult =
  | { ok: true; scan: Scan; sourceName: string; sourceTables: number }
  | { ok: false; reason: "source_not_found" | "scan_already_running" };

/**
 * Inicia un escaneo de forma atómica: crea el scan en estado `running`,
 * marca `last_scan_at` en la fuente y registra el evento de actividad.
 * Devuelve `source_not_found` si la fuente no existe (el handler responderá
 * 404 sin haber escrito nada).
 * FASE 7.0.5: garantía de un único scan `running` por fuente. La garantía
 * definitiva la da el índice único parcial de PostgreSQL
 * (`scans_one_running_per_source_idx`); aquí se añade un pre-check con
 * `FOR UPDATE` sobre la fuente para devolver 409 limpio sin depender de
 * capturar el 23505.
 */
export async function startScan({ sourceId, startedAt }: { sourceId: string; startedAt: Date }): Promise<StartScanResult> {
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(sourcesTable)
      .where(eq(sourcesTable.id, sourceId))
      .for("update");
    if (!source) return { ok: false, reason: "source_not_found" as const };

    const [existingRunning] = await tx
      .select({ id: scansTable.id })
      .from(scansTable)
      .where(and(eq(scansTable.sourceId, sourceId), eq(scansTable.status, "running")));
    if (existingRunning) {
      return { ok: false, reason: "scan_already_running" as const };
    }

    const [scan] = await tx
      .insert(scansTable)
      .values({
        id: newId("scan"),
        sourceId: source.id,
        status: "running",
        startedAt,
        completedAt: null,
        findingsCreated: 0,
      })
      .returning();

    await tx
      .update(sourcesTable)
      .set({ lastScanAt: startedAt, updatedAt: new Date() })
      .where(eq(sourcesTable.id, source.id));

    await tx.insert(activityTable).values({
      id: newId("a"),
      type: "scan",
      title: "Escaneo iniciado",
      description: `${source.name} · analizando ${source.tables} tablas`,
      createdAt: startedAt,
      severity: null,
    });

    return { ok: true, scan, sourceName: source.name, sourceTables: source.tables };
  });
}

/**
 * FASE 7.0.5: finaliza un escaneo en una ÚNICA transacción. Inserta los
 * findings, actualiza las métricas de la fuente (tables/records), acumula
 * las detecciones por regla y marca el scan como `completed`.
 */
export interface FinalizeScanInput {
  scanId: string;
  sourceId: string;
  sourceName: string;
  findings: Array<{
    location: string;
    dataType: string;
    severity: string;
    records: number;
    sample: string;
    regulation: string;
    recommendation: string;
    title: string;
  }>;
  scannedTables: number;
  recordsRead: number;
  ruleDeltas: Map<string, number>;
  completedAt: Date;
}

export async function finalizeScan(input: FinalizeScanInput): Promise<void> {
  await db.transaction(async (tx) => {
    for (const finding of input.findings) {
      await tx.insert(findingsTable).values({
        id: newId("f"),
        title: finding.title,
        dataType: finding.dataType,
        sourceId: input.sourceId,
        sourceName: input.sourceName,
        location: finding.location,
        severity: finding.severity,
        status: "open",
        records: finding.records,
        detectedAt: input.completedAt,
        regulation: finding.regulation,
        recommendation: finding.recommendation,
        sample: finding.sample,
        scanId: input.scanId,
      });
    }
    await tx.update(sourcesTable).set({
      tables: input.scannedTables,
      records: input.recordsRead,
      updatedAt: input.completedAt,
    }).where(eq(sourcesTable.id, input.sourceId));
    for (const [ruleName, delta] of input.ruleDeltas) {
      await tx.update(rulesTable).set({
        detections: sql`${rulesTable.detections} + ${delta}`,
        lastTriggered: input.completedAt,
        updatedAt: input.completedAt,
      }).where(sql`lower(${rulesTable.name}) = ${ruleName.toLowerCase()}`);
    }
    await tx.update(scansTable).set({
      status: "completed",
      completedAt: input.completedAt,
      findingsCreated: input.findings.length,
    }).where(eq(scansTable.id, input.scanId));
  });
}

/**
 * FASE 7.0.1: marca un escaneo como `failed` con su causa y registra el evento
 * de actividad. `completedAt` se fija al instante del fallo para cerrar el
 * ciclo en la vista de scans.
 */
export async function failScan({
  scanId,
  completedAt,
  reason,
}: {
  scanId: string;
  completedAt: Date;
  reason: "source_not_found" | "source_not_scannable" | "connection_failed" | "persist_failed";
}): Promise<Scan | null> {
  return db.transaction(async (tx) => {
    const [scan] = await tx.select().from(scansTable).where(eq(scansTable.id, scanId));
    if (!scan) return null;
    const [updated] = await tx.update(scansTable).set({ status: "failed", completedAt }).where(eq(scansTable.id, scanId)).returning();
    const [source] = await tx.select().from(sourcesTable).where(eq(sourcesTable.id, scan.sourceId));
    if (source) {
      await tx.insert(activityTable).values({
        id: newId("a"),
        type: "scan",
        title: "Escaneo fallido",
        description: `${source.name} · ${reason}`,
        createdAt: completedAt,
        severity: null,
      });
    }
    return updated;
  });
}

/**
 * Recuperación de scans huérfanos (FASE 7.0.4, refinada en FASE 7.1.0 M0):
 * marca como `failed(timeout)` todos los scans en estado `running` cuyo último
 * signo de vida — `heartbeat_at` si existe, con fallback a `started_at` para
 * los scans legacy — es ANTERIOR a `before`, en una única transacción.
 * Devuelve los scans actualizados (RETURNING).
 */
export async function failStaleRunningScans({
  before,
  completedAt,
  reason,
}: {
  before: Date;
  completedAt: Date;
  reason: "timeout";
}): Promise<Scan[]> {
  return db.transaction(async (tx) => {
    // FASE 7.1.0 M0: COALESCE(heartbeat_at, started_at) — un scan con latido
    // reciente no se recupera aunque startedAt sea viejo; los scans legacy
    // (sin latido) conservan el criterio original de 7.0.4. Frontera estricta.
    const stale = await tx
      .select()
      .from(scansTable)
      .where(
        and(
          eq(scansTable.status, "running"),
          sql`coalesce(${scansTable.heartbeatAt}, ${scansTable.startedAt}) < ${before}`,
        ),
      );
    const recovered: Scan[] = [];
    for (const scan of stale) {
      const [updated] = await tx.update(scansTable).set({ status: "failed", completedAt }).where(eq(scansTable.id, scan.id)).returning();
      const [source] = await tx.select().from(sourcesTable).where(eq(sourcesTable.id, scan.sourceId));
      if (source) {
        await tx.insert(activityTable).values({
          id: newId("a"),
          type: "scan",
          title: "Escaneo fallido",
          description: `${source.name} · ${reason}`,
          createdAt: completedAt,
          severity: null,
        });
      }
      recovered.push(updated);
    }
    return recovered;
  });
}

/**
 * FASE 7.1.0 M0: latido del scanner (best-effort). Actualiza `heartbeat_at` y
 * el progreso acumulado SOLO si el scan sigue `running` — la condición vive en
 * el propio WHERE, de modo que un scan que terminó entre medias no se toca
 * (0 filas, sin error). Statement único, idempotente, sin transacción.
 */
export async function heartbeatScan({
  scanId,
  at,
  tablesScanned,
  recordsRead,
}: {
  scanId: string;
  at: Date;
  tablesScanned: number;
  recordsRead: number;
}): Promise<void> {
  await db
    .update(scansTable)
    .set({ heartbeatAt: at, tablesScanned, recordsRead })
    .where(and(eq(scansTable.id, scanId), eq(scansTable.status, "running")));
}

/**
 * FASE 7.1.1 (M1): historial de scans. Filtros exactos por `sourceId` y
 * `status` (ya validados por el contrato en la ruta), orden `startedAt DESC,
 * id DESC` — un historial se lee de lo más reciente a lo más antiguo, y el id
 * como tiebreak garantiza paginación estable ante timestamps idénticos
 * (decisión D2; el resto de listados de la API es ASC porque son catálogos,
 * esto es una bitácora). Paginación aplicada en SQL.
 */
export async function list(
  filters: { sourceId?: string; status?: string } = {},
  pagination?: Pagination,
): Promise<Scan[]> {
  let query = db
    .select()
    .from(scansTable)
    .where(
      and(
        filters.sourceId ? eq(scansTable.sourceId, filters.sourceId) : undefined,
        filters.status ? eq(scansTable.status, filters.status) : undefined,
      ),
    )
    .orderBy(desc(scansTable.startedAt), desc(scansTable.id))
    .$dynamic();
  if (pagination) {
    query = query.limit(pagination.limit).offset(pagination.offset);
  }
  return query;
}

/** FASE 7.1.1 (M1): detalle de un scan por id (null si no existe). */
export async function getById(id: string): Promise<Scan | null> {
  const [scan] = await db
    .select()
    .from(scansTable)
    .where(eq(scansTable.id, id))
    .limit(1);
  return scan ?? null;
}
