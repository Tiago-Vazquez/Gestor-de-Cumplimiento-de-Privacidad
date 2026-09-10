import { and, count, eq, gte, isNotNull, lt } from "drizzle-orm";
import { db, findingsTable, scansTable } from "@workspace/db";
import { computeComplianceScore } from "./compliance-score";
import { activeFindingsWhere } from "./findings.repo";
import {
  UTC_MS_PER_DAY,
  buildTrendDayKeys,
  buildTrendPoints,
  utcDayStart,
  type TrendPointBucket,
} from "../lib/trend-buckets";

/**
 * Repositorio de métricas de compliance (FASE 7.2, M2.b).
 *
 * SOLO agregación sobre las tablas reales (no existen tablas de métricas):
 * cada lectura recalcula. Alimenta los contratos ya aprobados en OpenAPI
 * (`ComplianceSummary`, `ComplianceTrend`); el mapeo a ISO-strings y las
 * rutas HTTP llegan en la subfase siguiente (M2.c).
 *
 * - `complianceScore` proviene EXCLUSIVAMENTE de `computeComplianceScore`
 *   (única fuente de la política; ver compliance-score.ts).
 * - "Finding activo" es SIEMPRE la definición canónica de D8 vía
 *   `activeFindingsWhere()` (`status <> 'resolved'` AND `superseded = false`).
 * - Buffers acotados: el trend consulta solo la ventana
 *   [día1 00:00Z, díaN 24:00Z) y `findingsBySource` tiene cardinalidad de
 *   fuentes monitoreadas (decisión "no paginado" documentada en OpenAPI).
 */

/** Espejo del contrato OpenAPI (`ComplianceTrend.days`: default 30, máx 90). */
export const COMPLIANCE_TREND_DEFAULT_DAYS = 30;
export const COMPLIANCE_TREND_MAX_DAYS = 90;

export type SeverityCounts = { critical: number; high: number; medium: number; low: number };

export type ComplianceSummaryData = {
  /** Ver compliance-score.ts: política pendiente de definición (100/0). */
  complianceScore: number;
  openFindings: number;
  findingsBySeverity: SeverityCounts;
  findingsByDataType: Record<string, number>;
  findingsBySource: Array<{ sourceId: string; sourceName: string; openFindings: number }>;
};

export type ComplianceTrendData = {
  days: number;
  points: TrendPointBucket[];
};

/**
 * Orden canónico de `findingsBySource`: openFindings DESC, luego sourceName
 * ASC, con sourceId ASC como desempate estable final (dos fuentes pueden
 * empatar en conteo y nombre). Comparación por puntos de código, no
 * `localeCompare`, para que el orden no dependa del locale del proceso.
 */
function byOpenFindingsDesc(
  a: { sourceId: string; sourceName: string; openFindings: number },
  b: { sourceId: string; sourceName: string; openFindings: number },
): number {
  if (a.openFindings !== b.openFindings) return b.openFindings - a.openFindings;
  if (a.sourceName !== b.sourceName) return a.sourceName < b.sourceName ? -1 : 1;
  return a.sourceId < b.sourceId ? -1 : 1;
}

/**
 * Agregación PURA del summary (testeable sin base de datos): convierte las
 * filas agrupadas por SQL en el shape del contrato `ComplianceSummary`.
 *
 * - `openFindings` = suma de TODAS las filas por severidad: el WHERE ya es el
 *   canónico, así que una severidad fuera de dominio no puede hacer
 *   infracountar el score (las 4 claves del contrato sí quedan fijas).
 * - `findingsByDataType`: solo dataTypes con >= 1 finding activo; `{}` si no
 *   hay ninguno (contrato).
 * - `findingsBySource`: huérfanos (`sourceId` NULL) EXCLUIDOS sin bucket
 *   "unknown" (contrato); el orden canónico se aplica AQUÍ, en un único
 *   lugar (el SQL no ordena, para no duplicar la regla).
 */
export function summarizeComplianceAggregates(input: {
  severityRows: Array<{ severity: string; total: number }>;
  dataTypeRows: Array<{ dataType: string; total: number }>;
  sourceRows: Array<{ sourceId: string | null; sourceName: string; openFindings: number }>;
}): {
  openFindings: number;
  findingsBySeverity: SeverityCounts;
  findingsByDataType: Record<string, number>;
  findingsBySource: ComplianceSummaryData["findingsBySource"];
} {
  const openFindings = input.severityRows.reduce((sum, row) => sum + row.total, 0);

  const findingsBySeverity: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const row of input.severityRows) {
    if (row.severity in findingsBySeverity) {
      findingsBySeverity[row.severity as keyof SeverityCounts] = row.total;
    }
  }

  const findingsByDataType: Record<string, number> = {};
  for (const row of input.dataTypeRows) {
    findingsByDataType[row.dataType] = row.total;
  }

  const findingsBySource = input.sourceRows
    .filter((row): row is { sourceId: string; sourceName: string; openFindings: number } => row.sourceId !== null)
    .map((row) => ({ sourceId: row.sourceId, sourceName: row.sourceName, openFindings: row.openFindings }))
    .sort(byOpenFindingsDesc);

  return { openFindings, findingsBySeverity, findingsByDataType, findingsBySource };
}

/** Snapshot de métricas de compliance (contrato `ComplianceSummary`). */
export async function getComplianceSummary(): Promise<ComplianceSummaryData> {
  const severityRows = await db
    .select({ severity: findingsTable.severity, total: count() })
    .from(findingsTable)
    .where(activeFindingsWhere())
    .groupBy(findingsTable.severity);

  const dataTypeRows = await db
    .select({ dataType: findingsTable.dataType, total: count() })
    .from(findingsTable)
    .where(activeFindingsWhere())
    .groupBy(findingsTable.dataType);

  // `sourceId IS NOT NULL`: los huérfanos (fuente eliminada) no participan.
  const sourceRows = await db
    .select({
      sourceId: findingsTable.sourceId,
      sourceName: findingsTable.sourceName,
      openFindings: count(),
    })
    .from(findingsTable)
    .where(and(activeFindingsWhere(), isNotNull(findingsTable.sourceId)))
    .groupBy(findingsTable.sourceId, findingsTable.sourceName);

  const aggregates = summarizeComplianceAggregates({ severityRows, dataTypeRows, sourceRows });

  return {
    complianceScore: computeComplianceScore({ openFindings: aggregates.openFindings }),
    openFindings: aggregates.openFindings,
    findingsBySeverity: aggregates.findingsBySeverity,
    findingsByDataType: aggregates.findingsByDataType,
    findingsBySource: aggregates.findingsBySource,
  };
}

/**
 * Trend diario de los últimos `days` días UTC, hoy incluido (contrato
 * `ComplianceTrend`). Exactamente `days` puntos, el más antiguo primero,
 * cero-incluidos. `now` es inyectable para tests deterministas.
 *
 * La ruta validará `days` con el zod del contrato (400 fuera de 1..90);
 * el rango se defiende igualmente aquí para que ningún caller silencie una
 * ventana inválida.
 */
export async function getComplianceTrend(days: number, now: Date = new Date()): Promise<ComplianceTrendData> {
  if (!Number.isInteger(days) || days < 1 || days > COMPLIANCE_TREND_MAX_DAYS) {
    throw new RangeError(`days debe ser un entero en 1..${COMPLIANCE_TREND_MAX_DAYS}, recibido ${days}`);
  }

  const dayKeys = buildTrendDayKeys(days, now);
  const windowStart = utcDayStart(dayKeys[0]);
  const windowEnd = new Date(utcDayStart(dayKeys[dayKeys.length - 1]).getTime() + UTC_MS_PER_DAY);

  // Altas: canónicos (superseded = false) por firstSeenAt. El status actual
  // es irrelevante: un finding detectado lunes y resuelto martes SÍ cuenta el
  // lunes (contrato ComplianceTrendPoint.newFindings).
  const newFindingRows = await db
    .select({ at: findingsTable.firstSeenAt })
    .from(findingsTable)
    .where(
      and(
        eq(findingsTable.superseded, false),
        isNotNull(findingsTable.firstSeenAt),
        gte(findingsTable.firstSeenAt, windowStart),
        lt(findingsTable.firstSeenAt, windowEnd),
      ),
    );

  // Resoluciones: instante persistido de resolución (updatedAt de filas
  // actualmente 'resolved'; el único write que deja una fila en resolved).
  const resolvedRows = await db
    .select({ at: findingsTable.updatedAt })
    .from(findingsTable)
    .where(
      and(
        eq(findingsTable.status, "resolved"),
        gte(findingsTable.updatedAt, windowStart),
        lt(findingsTable.updatedAt, windowEnd),
      ),
    );

  // Scans completados por completedAt; recordsScanned suma su recordsRead.
  const scanRows = await db
    .select({ at: scansTable.completedAt, recordsRead: scansTable.recordsRead })
    .from(scansTable)
    .where(
      and(
        eq(scansTable.status, "completed"),
        isNotNull(scansTable.completedAt),
        gte(scansTable.completedAt, windowStart),
        lt(scansTable.completedAt, windowEnd),
      ),
    );

  return {
    days,
    points: buildTrendPoints({
      dayKeys,
      newFindings: newFindingRows,
      resolvedFindings: resolvedRows,
      completedScans: scanRows,
    }),
  };
}

