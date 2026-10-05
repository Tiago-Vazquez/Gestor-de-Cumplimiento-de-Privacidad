import { count, desc, eq, and } from "drizzle-orm";
import { activityTable, db, findingsTable, reportsTable, type Report } from "@workspace/db";
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

    const [report] = await tx
      .insert(reportsTable)
      .values({
        id: newId("r"),
        name,
        period,
        status: "ready",
        createdAt: at,
        findings: openFindings,
        complianceScore: computeComplianceScore(findingsBySeverity),
        format: "pdf",
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
