import { eq } from "drizzle-orm";
import { db, userRolesTable } from "@workspace/db";

export async function listRolesForUser(sub: string): Promise<string[]> {
  const rows = await db
    .select({ role: userRolesTable.role })
    .from(userRolesTable)
    .where(eq(userRolesTable.userSub, sub));
  return rows.map((row) => row.role);
}

/** Asigna un rol si no existe (idempotente gracias a la PK compuesta). */
export async function addRole(sub: string, role: "admin" | "auditor"): Promise<void> {
  await db
    .insert(userRolesTable)
    .values({ userSub: sub, role })
    .onConflictDoNothing();
}

/**
 * Reemplaza el conjunto de roles de un usuario de forma atómica (transacción)
 * para sincronizar el catálogo administrado por `ADMIN_EMAILS`/política futura.
 */
export async function setRoles(sub: string, roles: string[]): Promise<string[]> {
  await db.transaction(async (tx) => {
    await tx.delete(userRolesTable).where(eq(userRolesTable.userSub, sub));
    if (roles.length > 0) {
      await tx.insert(userRolesTable).values(
        roles.map((role) => ({ userSub: sub, role })),
      );
    }
  });
  return roles;
}