import { eq, inArray } from "drizzle-orm";
import { db, organizationsTable } from "@workspace/db";

/**
 * M21.2 — Repositorio de organizaciones (lectura).
 *
 * Las organizaciones NO se crean por HTTP en MVP: la primera organización y el
 * primer administrador se provisionan con `db:provision-admin` (M22 P0-2), y
 * el alta de miembros es por invitación a una organización existente.
 */

/** Detalle de organizaciones por id (para respuestas de org context). */
export async function getByIds(
  ids: string[],
): Promise<Map<string, { id: string; name: string; slug: string; createdAt: Date }>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: organizationsTable.id,
      name: organizationsTable.name,
      slug: organizationsTable.slug,
      createdAt: organizationsTable.createdAt,
    })
    .from(organizationsTable)
    .where(inArray(organizationsTable.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

export async function getById(
  id: string,
): Promise<{ id: string; name: string; slug: string; createdAt: Date } | null> {
  const map = await getByIds([id]);
  return map.get(id) ?? null;
}

/** Existencia (para validaciones de FK lógica antes de tener FK en runtime). */
export async function exists(id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, id))
    .limit(1);
  return row !== undefined;
}