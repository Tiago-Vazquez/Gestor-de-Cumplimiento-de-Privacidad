import { eq, inArray } from "drizzle-orm";
import { db, organizationsTable } from "@workspace/db";

/**
 * M21.2 — Repositorio mínimo de organizaciones.
 *
 * MVP: las organizaciones se crean SOLO aquí (bootstrap) — no existe todavía
 * self-service signup de organizaciones (el flujo de entrada es por
 * invitación a una organización existente). `ensureBootstrapOrganization` es
 * idempotente (id determinístico + ON CONFLICT DO NOTHING) para que cada
 * login bootstrap deje la organización inicial en el mismo estado.
 */
export const BOOTSTRAP_ORGANIZATION_ID = "org-bootstrap";
export const BOOTSTRAP_ORGANIZATION_SLUG = "bootstrap";

export async function ensureBootstrapOrganization(): Promise<void> {
  await db
    .insert(organizationsTable)
    .values({
      id: BOOTSTRAP_ORGANIZATION_ID,
      name: "Bootstrap Organization",
      slug: BOOTSTRAP_ORGANIZATION_SLUG,
      status: "active",
    })
    .onConflictDoNothing({ target: organizationsTable.id });
}

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