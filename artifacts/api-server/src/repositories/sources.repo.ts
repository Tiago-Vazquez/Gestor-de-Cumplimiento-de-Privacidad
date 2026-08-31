import { asc, count, eq } from "drizzle-orm";
import { db, findingsTable, sourcesTable, type Source } from "@workspace/db";

export type SourceWithFindingsCount = Source & { findingsCount: number };

/**
 * Fuentes monitoreadas con el número de hallazgos asociados (D3: el contrato
 * expone `findings` como conteo, que no es columna de la tabla).
 * Orden estable: creación y, a igualdad, id.
 */
export async function list(): Promise<SourceWithFindingsCount[]> {
  const rows = await db
    .select({ source: sourcesTable, findingsCount: count(findingsTable.id) })
    .from(sourcesTable)
    .leftJoin(findingsTable, eq(findingsTable.sourceId, sourcesTable.id))
    .groupBy(sourcesTable.id)
    .orderBy(asc(sourcesTable.createdAt), asc(sourcesTable.id));

  return rows.map((row) => ({ ...row.source, findingsCount: row.findingsCount }));
}

export async function getById(id: string): Promise<Source | null> {
  const [row] = await db.select().from(sourcesTable).where(eq(sourcesTable.id, id));
  return row ?? null;
}

/** Actualiza `last_scan_at` tras iniciar un escaneo (operación atómica de una
 * sola sentencia; las transacciones multi-tabla viven en scans.repo). */
export async function touchLastScan({ id, at }: { id: string; at: Date }): Promise<Source | null> {
  const [row] = await db
    .update(sourcesTable)
    .set({ lastScanAt: at, updatedAt: new Date() })
    .where(eq(sourcesTable.id, id))
    .returning();
  return row ?? null;
}
