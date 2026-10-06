import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import {
  activityTable,
  db,
  findingsTable,
  organizationsTable,
  reportsTable,
  type Report,
  type ReportContent,
  type ReportContentRisk,
} from "@workspace/db";
import type { Pagination } from "../lib/pagination";
import { activeFindingsWhere } from "./findings.repo";
import { computeComplianceScore, type SeverityCounts } from "./compliance-score";
import { newId } from "./ids";
import { tenantScopeStrict, withTenant, setTenantLocal } from "./tenant";

/** F4 (6.3B.20): paginación aplicada en SQL, orden estable. */
export async function list(pagination: Pagination | undefined, tenantId: string): Promise<Report[]> {
  return withTenant(tenantId, async (tx) => {
    let query = tx
      .select()
      .from(reportsTable)
      // M21.8 — scoping por tenant en el WHERE + tenant context transaccional.
      .where(tenantScopeStrict(reportsTable.tenantId, tenantId))
      .orderBy(desc(reportsTable.createdAt), desc(reportsTable.id))
      .$dynamic();
    if (pagination) {
      query = query.limit(pagination.limit).offset(pagination.offset);
    }
    return query;
  });
}

/** F4 (M4): obtención puntual por id; null si no existe o es ajeno (404 uniforme). */
export async function getById(id: string, tenantId: string): Promise<Report | null> {
  return withTenant(tenantId, async (tx) => {
    const [report] = await tx
      .select()
      .from(reportsTable)
      .where(
        and(
          eq(reportsTable.id, id),
          tenantScopeStrict(reportsTable.tenantId, tenantId),
        ),
      );
    return report ?? null;
  });
}

/** Versión del snapshot `content` (independiente del versionado del producto). */
const REPORT_CONTENT_VERSION = "1.0";

/** Resumen ejecutivo determinista, derivado de los agregados ya calculados. */
function buildExecutiveSummary(
  organizationName: string,
  score: number,
  total: number,
  sev: SeverityCounts,
): string {
  const buckets = [
    `${sev.critical} crítico${sev.critical === 1 ? "" : "s"}`,
    `${sev.high} alto${sev.high === 1 ? "" : "s"}`,
    `${sev.medium} medio${sev.medium === 1 ? "" : "s"}`,
    `${sev.low} bajo${sev.low === 1 ? "" : "s"}`,
  ];
  return (
    `Informe de cumplimiento de ${organizationName}. ` +
    `El compliance score es ${score} / 100 sobre ${total} hallazgo${total === 1 ? "" : "s"} activo${total === 1 ? "" : "s"} ` +
    `(${buckets.join(", ")}).`
  );
}

/**
 * Genera un informe de forma atómica: calcula los hallazgos pendientes y el
 * compliance score con la política actual (ver compliance-score.ts), inserta
 * el informe `ready` en formato PDF y registra el evento de actividad.
 * M21.3: el informe y su actividad se stampan con el tenant de la
 * organización activa, y el conteo de hallazgos se scoped al mismo tenant.
 */
export async function create({
  name,
  period,
  at,
  tenantId,
}: {
  name: string;
  period: string;
  at: Date;
  /** M21.4 — tenant de la organización activa (tenant_id NOT NULL). */
  tenantId: string;
}): Promise<Report> {
  return db.transaction(async (tx) => {
    // M21.8 — tenant context transaccional (RLS).
    await setTenantLocal(tx, tenantId);

    // Desglose por severidad: el score lo exige (ADR-004). `findings` sigue
    // siendo el TOTAL de activos, igual que antes.
    const severityRows = await tx
      .select({ severity: findingsTable.severity, total: count() })
      .from(findingsTable)
      .where(activeFindingsWhere(tenantId))
      .groupBy(findingsTable.severity);
    const findingsBySeverity: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const row of severityRows) {
      if (row.severity in findingsBySeverity) {
        findingsBySeverity[row.severity as keyof SeverityCounts] = row.total;
      }
    }
    // ADR-004 (M34.0): `openFindings` (persistido en `findings`) deriva SOLO de
    // las 4 severidades válidas, para no divergir del `complianceScore`.
    const openFindings =
      findingsBySeverity.critical + findingsBySeverity.high + findingsBySeverity.medium + findingsBySeverity.low;
    const complianceScore = computeComplianceScore(findingsBySeverity);

    // FASE 8 (PDF): desglose por tipo de dato (mismo WHERE canónico).
    const dataTypeRows = await tx
      .select({ dataType: findingsTable.dataType, total: count() })
      .from(findingsTable)
      .where(activeFindingsWhere(tenantId))
      .groupBy(findingsTable.dataType);
    const findingsByDataType = dataTypeRows
      .map((row) => ({ label: row.dataType, count: row.total }))
      .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

    // FASE 8 (PDF): top riesgos + recomendaciones, de los mismos hallazgos activos.
    const severityRankSql =
      sql`case ${findingsTable.severity} when 'critical' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end`;
    const topRows = await tx
      .select({
        title: findingsTable.title,
        severity: findingsTable.severity,
        dataType: findingsTable.dataType,
        source: findingsTable.sourceName,
        records: findingsTable.records,
        regulation: findingsTable.regulation,
        recommendation: findingsTable.recommendation,
      })
      .from(findingsTable)
      .where(activeFindingsWhere(tenantId))
      .orderBy(desc(severityRankSql), desc(findingsTable.records), desc(findingsTable.detectedAt), asc(findingsTable.id))
      .limit(15);

    const topRisks: ReportContentRisk[] = topRows.slice(0, 5);
    const recommendations = Array.from(
      new Set(topRows.map((row) => row.recommendation).filter((value) => value.length > 0)),
    ).slice(0, 8);

    const [organization] = await tx
      .select({ name: organizationsTable.name })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, tenantId));
    const organizationName = organization?.name ?? "Organización";

    const content: ReportContent = {
      version: REPORT_CONTENT_VERSION,
      generatedAt: at.toISOString(),
      organizationName,
      executiveSummary: buildExecutiveSummary(organizationName, complianceScore, openFindings, findingsBySeverity),
      severityCounts: findingsBySeverity,
      findingsByDataType,
      topRisks,
      recommendations,
    };

    const [report] = await tx
      .insert(reportsTable)
      .values({
        id: newId("r"),
        name,
        period,
        status: "ready",
        createdAt: at,
        findings: openFindings,
        complianceScore,
        format: "pdf",
        content,
        // M21.4 — el informe pertenece a la organización activa.
        tenantId,
      })
      .returning();

    await tx.insert(activityTable).values({
      id: newId("a"),
      type: "report",
      title: "Informe generado",
      description: name,
      createdAt: at,
      severity: null,
      tenantId: report.tenantId,
    });

    return report;
  });
}
