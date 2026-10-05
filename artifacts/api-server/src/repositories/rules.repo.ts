import { asc, eq, sql } from "drizzle-orm";
import { db, rulesTable, type Rule } from "@workspace/db";
import type { Pagination } from "../lib/pagination";

/** F4 (6.3B.20): paginación aplicada en SQL, orden estable. */
export function list(pagination?: Pagination): Promise<Rule[]> {
  let query = db
    .select()
    .from(rulesTable)
    .orderBy(asc(rulesTable.createdAt), asc(rulesTable.id))
    .$dynamic();
  if (pagination) {
    query = query.limit(pagination.limit).offset(pagination.offset);
  }
  return query;
}

/**
 * FASE 7.0.5: actualiza únicamente el campo `enabled` de una regla. Devuelve
 * la regla actualizada o null si no existe. Solo este campo es gobernable
 * desde la API; el resto (patrón, severidad, regulación) es built-in.
 */
export async function setEnabled({
  id,
  enabled,
  at,
}: {
  id: string;
  enabled: boolean;
  at: Date;
}): Promise<Rule | null> {
  const [updated] = await db
    .update(rulesTable)
    .set({ enabled, updatedAt: at })
    .where(eq(rulesTable.id, id))
    .returning();
  return updated ?? null;
}
