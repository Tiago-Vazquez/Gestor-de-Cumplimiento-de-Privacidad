import { count, eq, ne, sql } from "drizzle-orm";
import { db, findingsTable, scansTable, sourcesTable } from "@workspace/db";
import { computeComplianceScore } from "./compliance-score";

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
 */
export async function getDashboardData(): Promise<DashboardData> {
  const severityRows = await db
    .select({ severity: findingsTable.severity, total: count() })
    .from(findingsTable)
    .where(ne(findingsTable.status, "resolved"))
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
    .from(sourcesTable);

  const [runningRow] = await db
    .select({ total: count() })
    .from(scansTable)
    .where(eq(scansTable.status, "running"));

  const [lastScanRow] = await db
    .select({ last: sql<Date | null>`MAX(${sourcesTable.lastScanAt})` })
    .from(sourcesTable);

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
