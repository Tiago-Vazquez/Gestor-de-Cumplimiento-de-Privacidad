import { and, asc, count, desc, eq, ne, type SQL } from "drizzle-orm";
import { activityTable, db, findingsTable, type Finding } from "@workspace/db";
import { newId } from "./ids";

export type FindingsFilter = { status?: string; severity?: string };

export function list(filter: FindingsFilter = {}): Promise<Finding[]> {
  const conditions: SQL[] = [];
  if (filter.status) conditions.push(eq(findingsTable.status, filter.status));
  if (filter.severity) conditions.push(eq(findingsTable.severity, filter.severity));

  return db
    .select()
    .from(findingsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(findingsTable.detectedAt), asc(findingsTable.id));
}

export async function getById(id: string): Promise<Finding | null> {
  const [row] = await db.select().from(findingsTable).where(eq(findingsTable.id, id));
  return row ?? null;
}

/**
 * Cambia el estado de un hallazgo y registra el evento de actividad
 * correspondiente en la misma transacción (el handler responde 404 con
 * `null` sin haber escrito nada).
 */
export async function updateStatus({ id, status, at }: { id: string; status: string; at: Date }): Promise<Finding | null> {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(findingsTable)
      .set({ status, updatedAt: at })
      .where(eq(findingsTable.id, id))
      .returning();

    if (!updated) return null;

    await tx.insert(activityTable).values({
      id: newId("a"),
      type: "finding",
      title: status === "resolved" ? "Hallazgo resuelto" : "Hallazgo actualizado",
      description: updated.title,
      createdAt: at,
      severity: updated.severity,
    });

    return updated;
  });
}

/** Hallazgos pendientes (`status <> "resolved"`), base de métricas del
 * dashboard y de los informes. */
export async function countOpen(): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(findingsTable)
    .where(ne(findingsTable.status, "resolved"));
  return row?.total ?? 0;
}
