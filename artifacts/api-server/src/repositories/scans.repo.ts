import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
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
import {
  computeFingerprint,
  planFindingLifecycle,
} from "../services/finding-lifecycle";

export type StartScanResult =
  | { ok: true; scan: Scan; sourceName: string; sourceTables: number }
  | { ok: false; reason: "source_not_found" | "scan_already_running" };

/**
 * FASE 7.1.2 (M2): resultado de una solicitud de cancelación cooperativa.
 * La cancelación NO cambia el status desde el endpoint — solo marca el flag;
 * la terminación `failed(cancelled)` la ejecuta el scanner en su siguiente
 * punto de yield (o el reaper si el scanner murió).
 */
export type CancelScanResult =
  | { ok: true; scan: Scan }
  | { ok: false; reason: "scan_not_found" | "scan_not_running" };

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
 * FASE 7.2.1 (M1): finaliza un escaneo en una ÚNICA transacción aplicando el
 * finding lifecycle (¿nuevo / persistente / resuelto / reabierto?) y actualiza
 * las métricas de la fuente (tables/records), acumula las detecciones por regla
 * y marca el scan como `completed`.
 *
 * Todas las escrituras del lifecycle (inserts/updates/reconciliación) ocurren
 * DENTRO de esta transacción: si cualquier paso falla, PostgreSQL hace rollback
 * y NUNCA queda un estado donde findings hayan sido reconciliados como resueltos
 * y el scan haya terminado `failed`.
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
  /**
   * Reconciliación por ausencia permitida SOLO si el scan terminó `completed`
   * con cobertura completa (todas las tablas listadas escaneadas y sin tope de
   * findings aplicado). El scanner calcula este flag; es `false` en cualquier
   * otro caso (failed/cancelled/timeout/incompleto), donde la ausencia no es
   * evidencia de que un finding desapareció.
   */
  reconcileAbsence: boolean;
}

export async function finalizeScan(input: FinalizeScanInput): Promise<void> {
  await db.transaction(async (tx) => {
    const fingerprints = [
      ...new Set(
        input.findings.map((finding) =>
          computeFingerprint({
            sourceId: input.sourceId,
            location: finding.location,
            dataType: finding.dataType,
          }),
        ),
      ),
    ];

    // Findings canónicos ya persistidos (superseded=false) con el mismo
    // fingerprint — incluye resolved para poder reabrirlos. FOR UPDATE
    // serializa el upsert frente a otro finalize simultáneo del mismo finding;
    // el índice único parcial findings_fingerprint_active_idx es la última
    // línea de defensa contra duplicados.
    const existing = fingerprints.length > 0
      ? await tx
          .select()
          .from(findingsTable)
          .where(and(inArray(findingsTable.fingerprint, fingerprints), eq(findingsTable.superseded, false)))
          .for("update")
      : [];
    const existingByFingerprint = new Map<string, (typeof existing)[number]>();
    for (const row of existing) {
      if (row.fingerprint) existingByFingerprint.set(row.fingerprint, row);
    }

    // Finding activos de esta fuente: candidatos a resolución por ausencia.
    // Solo se consultan cuando la reconciliación está permitida (completed +
    // cobertura completa).
    const activeForSource = input.reconcileAbsence
      ? await tx
          .select()
          .from(findingsTable)
          .where(
            and(
              eq(findingsTable.sourceId, input.sourceId),
              eq(findingsTable.superseded, false),
              ne(findingsTable.status, "resolved"),
            ),
          )
      : [];

    const plan = planFindingLifecycle({
      sourceId: input.sourceId,
      scanId: input.scanId,
      at: input.completedAt,
      detections: input.findings,
      existingByFingerprint,
      activeForSource,
      reconcileAbsence: input.reconcileAbsence,
    });

    // 1. Findings NUEVOS (fingerprint desconocido): se inserta una única
    // entidad lógica (scanId) = scan creador, firstSeen = lastSeen.
    for (const finding of plan.toInsert) {
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
        fingerprint: finding.fingerprint,
        firstSeenAt: input.completedAt,
        lastSeenAt: input.completedAt,
        lastSeenScanId: input.scanId,
      });
    }

    // 2. Findings PERSISTENTES (mismo fingerprint en un scan posterior): se
    // reutiliza el MISMO id; firstSeenAt y scanId se conservan intactos;
    // lastSeenScanId apunta al scan actual como última observación.
    for (const update of plan.toUpdate) {
      await tx
        .update(findingsTable)
        .set({
          status: update.nextStatus,
          records: update.records,
          sample: update.sample,
          severity: update.severity,
          regulation: update.regulation,
          recommendation: update.recommendation,
          title: update.title,
          lastSeenAt: input.completedAt,
          lastSeenScanId: update.lastSeenScanId,
          updatedAt: input.completedAt,
        })
        .where(eq(findingsTable.id, update.findingId));
    }

    // 3. Reconciliación por ausencia: findings activos no detectados en un
    // scan completed con cobertura completa → resolved (nunca en failed/cancelled).
    if (plan.toResolveIds.length > 0) {
      await tx
        .update(findingsTable)
        .set({ status: "resolved", updatedAt: input.completedAt })
        .where(inArray(findingsTable.id, plan.toResolveIds));
    }

    // 4. Métricas de la fuente, deltas por regla y cierre del scan. Los
    // finding actuales solo se crean una vez; `findingsCreated` es la cantidad
    // de findings NUEVOS creados por este scan, no las re-detecciones.
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
      findingsCreated: plan.createdCount,
    }).where(eq(scansTable.id, input.scanId));
  });
}

/**
 * FASE 7.0.1: marca un escaneo como `failed` con su causa y registra el evento
 * de actividad. `completedAt` se fija al instante del fallo para cerrar el
 * ciclo en la vista de scans.
 *
 * FASE 7.1.2 (M2, D2): guard de estado — el UPDATE exige `status='running'`,
 * de modo que una finalización tardía (p. ej. `failed(cancelled)` de un
 * scanner lento tras un reapeo `failed(timeout)`) NO sobrescribe un estado
 * terminal ya producido ni duplica la actividad de cierre. En ese caso
 * devuelve la fila terminal existente sin tocar nada.
 */
export async function failScan({
  scanId,
  completedAt,
  reason,
}: {
  scanId: string;
  completedAt: Date;
  reason: "source_not_found" | "source_not_scannable" | "connection_failed" | "persist_failed" | "cancelled";
}): Promise<Scan | null> {
  return db.transaction(async (tx) => {
    const [scan] = await tx.select().from(scansTable).where(eq(scansTable.id, scanId));
    if (!scan) return null;
    const [updated] = await tx
      .update(scansTable)
      .set({ status: "failed", completedAt })
      .where(and(eq(scansTable.id, scanId), eq(scansTable.status, "running")))
      .returning();
    if (!updated) return scan;
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
 *
 * FASE 7.1.2 (M2): devuelve la fila post-update (`UPDATE … RETURNING`) para
 * que el scanner lea el `cancelRequested` vigente SIN consultas extra. `null`
 * = 0 filas (scan inexistente o ya no running).
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
}): Promise<Scan | null> {
  const [updated] = await db
    .update(scansTable)
    .set({ heartbeatAt: at, tablesScanned, recordsRead })
    .where(and(eq(scansTable.id, scanId), eq(scansTable.status, "running")))
    .returning();
  return updated ?? null;
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

/**
 * FASE 7.1.2 (M2): solicita la cancelación cooperativa de un scan. Transacción
 * con `FOR UPDATE` para serializar frente al reaper y frente a dobles
 * solicitudes. Marca `cancel_requested = true` SIN cambiar el status — la
 * terminación la ejecuta el scanner en su siguiente yield (o el reaper si
 * murió). Idempotente: pedir cancel dos veces mientras siga `running` es un
 * éxito (segunda llamada retorna el scan ya marcado).
 */
export async function requestCancel({
  scanId,
}: {
  scanId: string;
}): Promise<CancelScanResult> {
  return db.transaction(async (tx) => {
    const [scan] = await tx
      .select()
      .from(scansTable)
      .where(eq(scansTable.id, scanId))
      .for("update");
    if (!scan) return { ok: false, reason: "scan_not_found" as const };
    if (scan.status !== "running") {
      return { ok: false, reason: "scan_not_running" as const };
    }
    if (scan.cancelRequested) return { ok: true, scan };
    const [updated] = await tx
      .update(scansTable)
      .set({ cancelRequested: true })
      .where(eq(scansTable.id, scanId))
      .returning();
    return { ok: true, scan: updated };
  });
}
