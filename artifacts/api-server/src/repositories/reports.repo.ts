import { count, desc, ne } from "drizzle-orm";
import { activityTable, db, findingsTable, reportsTable, type Report } from "@workspace/db";
import { computeComplianceScore } from "./compliance-score";
import { newId } from "./ids";

export function list(): Promise<Report[]> {
  return db
    .select()
    .from(reportsTable)
    .orderBy(desc(reportsTable.createdAt), desc(reportsTable.id));
}

/**
 * Genera un informe de forma atómica: calcula los hallazgos pendientes y el
 * compliance score con la política actual (ver compliance-score.ts), inserta
 * el informe `ready` en formato PDF y registra el evento de actividad.
 */
export async function create({ name, period, at }: { name: string; period: string; at: Date }): Promise<Report> {
  return db.transaction(async (tx) => {
    const [openRow] = await tx
      .select({ total: count() })
      .from(findingsTable)
      .where(ne(findingsTable.status, "resolved"));
    const openFindings = openRow?.total ?? 0;

    const [report] = await tx
      .insert(reportsTable)
      .values({
        id: newId("r"),
        name,
        period,
        status: "ready",
        createdAt: at,
        findings: openFindings,
        complianceScore: computeComplianceScore({ openFindings }),
        format: "pdf",
      })
      .returning();

    await tx.insert(activityTable).values({
      id: newId("a"),
      type: "report",
      title: "Informe generado",
      description: name,
      createdAt: at,
      severity: null,
    });

    return report;
  });
}
