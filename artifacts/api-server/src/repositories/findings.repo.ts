import { and, asc, desc, eq, ne, type SQL } from "drizzle-orm";
import { activityTable, db, findingsTable, type Finding } from "@workspace/db";
import type { Pagination } from "../lib/pagination";
import { newId } from "./ids";
import { tenantScopeStrict } from "./tenant";

export type FindingsFilter = { status?: string; severity?: string };

/**
 * M21.3 — Predicado canónico D8 + scoping por tenant (D2). Único punto donde
 * se combinan: los consumidores (compliance, dashboard, reports, scans) lo
 * reutilizan para que ninguna métrica escape del tenant activo.
 */
export function activeFindingsWhere(tenantId: string): SQL | undefined {
  const canonical = and(
    ne(findingsTable.status, "resolved"),
    eq(findingsTable.superseded, false),
  );
  return and(canonical, tenantScopeStrict(findingsTable.tenantId, tenantId));
}

/**
 * F4 (6.3B.20): LIMIT/OFFSET se aplican en la sentencia SQL (nunca solo en
 * cliente). Sin paginación explícita la consulta queda como antes.
 */
export function list(
  filter: FindingsFilter,
  pagination: Pagination | undefined,
  tenantId: string,
): Promise<Finding[]> {
  const conditions: SQL[] = [];
  if (filter.status) conditions.push(eq(findingsTable.status, filter.status));
  if (filter.severity) conditions.push(eq(findingsTable.severity, filter.severity));
  // M21.7 — scoping ESTRICTO obligatorio en el WHERE.
  conditions.push(tenantScopeStrict(findingsTable.tenantId, tenantId));

  let query = db
    .select()
    .from(findingsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(findingsTable.detectedAt), asc(findingsTable.id))
    .$dynamic();
  if (pagination) {
    query = query.limit(pagination.limit).offset(pagination.offset);
  }
  return query;
}

/**
 * Cambia el estado de un hallazgo y registra el evento de actividad
 * correspondiente en la misma transacción (el handler responde 404 con
 * `null` sin haber escrito nada). M21.3: el scoping vive en el WHERE del
 * UPDATE — un finding ajeno produce 0 filas sin tocar nada.
 */
export async function updateStatus(
  { id, status, at }: { id: string; status: string; at: Date },
  tenantId: string,
): Promise<Finding | null> {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(findingsTable)
      .set({ status, updatedAt: at })
      .where(
        and(
          eq(findingsTable.id, id),
          tenantScopeStrict(findingsTable.tenantId, tenantId),
        ),
      )
      .returning();

    if (!updated) return null;

    await tx.insert(activityTable).values({
      id: newId("a"),
      type: "finding",
      title: status === "resolved" ? "Hallazgo resuelto" : "Hallazgo actualizado",
      description: updated.title,
      createdAt: at,
      severity: updated.severity,
      // M21.3 — el evento de actividad hereda el tenant del finding.
      tenantId: updated.tenantId,
    });

    return updated;
  });
}
