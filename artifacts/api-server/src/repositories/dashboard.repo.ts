import { and, count, eq, sql } from "drizzle-orm";
import { db, findingsTable, scansTable, sourcesTable } from "@workspace/db";
import { activeFindingsWhere } from "./findings.repo";
import { computeComplianceScore } from "./compliance-score";
import { tenantScopeStrict } from "./tenant";

export type DashboardData = {
  countsBySeverity: { critical: number; high: number; medium: number; low: number };
  openFindings: number;
  /** Aprobado: SUM(sources.records). NULL cuando no hay fuentes → 0. */
  protectedRecords: number;
  monitoredSources: number;
  /** MAX(sources.last_scan_at); NULL cuando no hay fuentes ni escaneos. */
  lastScanAt: Date | null;
  scanStatus: "scanning" | "monitoring";
  /** Ver compliance-score.ts: política pendiente de definición. */
  complianceScore: number;
};

/**
 * Datos del dashboard calculados íntegramente con agregaciones sobre las
 * tablas reales (no existe tabla `dashboard`).
 * M21.3 — TODAS las agregaciones quedan scoped al tenant activo (D2):
 * findings por `findings.tenant_id`; sources por `sources.tenant_id`;
 * los scans (sin columna propia) por JOIN con su source.
 */
export async function getDashboardData(tenantId: string): Promise<DashboardData> {
  const findingScope = tenantScopeStrict(findingsTable.tenantId, tenantId);
  // M21.7 — cada tabla usa SU propia columna tenant_id en el predicado.
  const sourceScope = tenantScopeStrict(sourcesTable.tenantId, tenantId);

  const severityRows = await db
    .select({ severity: findingsTable.severity, total: count() })
    .from(findingsTable)
    .where(activeFindingsWhere(tenantId))
    .groupBy(findingsTable.severity);

  const countsBySeverity: DashboardData["countsBySeverity"] = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const row of severityRows) {
    if (row.severity in countsBySeverity) {
      countsBySeverity[row.severity as keyof typeof countsBySeverity] = row.total;
    }
  }
  const openFindings = severityRows.reduce((sum, row) => sum + row.total, 0);

  const [sourcesRow] = await db
    .select({
      total: count(),
      protectedRecords: sql<number>`COALESCE(SUM(${sourcesTable.records}), 0)::int`,
    })
    .from(sourcesTable)
    .where(sourceScope);

  const [runningRow] = await db
    .select({ total: count() })
    .from(scansTable)
    // M21.3 — scans sin tenant propio: se scoped vía su source.
    .innerJoin(sourcesTable, eq(scansTable.sourceId, sourcesTable.id))
    .where(
      and(
        eq(scansTable.status, "running"),
        tenantScopeStrict(sourcesTable.tenantId, tenantId),
      ),
    );

  const [lastScanRow] = await db
    .select({ last: sql<Date | null>`MAX(${sourcesTable.lastScanAt})` })
    .from(sourcesTable)
    .where(sourceScope);

  return {
    countsBySeverity,
    openFindings,
    protectedRecords: sourcesRow?.protectedRecords ?? 0,
    monitoredSources: sourcesRow?.total ?? 0,
    lastScanAt: lastScanRow?.last ?? null,
    scanStatus: (runningRow?.total ?? 0) > 0 ? "scanning" : "monitoring",
    complianceScore: computeComplianceScore({ openFindings }),
  };
}
