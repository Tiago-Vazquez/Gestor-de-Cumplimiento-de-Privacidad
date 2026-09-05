import { eq } from "drizzle-orm";
import { db, userRolesTable, usersTable } from "@workspace/db";
import { forbidden } from "../lib/errors";
import { revokeAllSessionsForUserTx } from "./sessions.repo";

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

/** Resultado del cambio de roles atómico (6.3B.10). */
export interface SetRolesResult {
  /** Roles efectivos tras la operación. */
  applied: string[];
  /** `true` si el conjunto cambió respecto al estado al momento de MUTAR. */
  changed: boolean;
  /** Sesiones activas revocadas (0 si no hubo cambio efectivo). */
  revokedSessions: number;
}

/**
 * Cambio de roles + revocación de todas las sesiones activas del usuario en
 * UNA SOLA transacción PostgreSQL (BEGIN → locks → invariante → actualizar
 * user_roles → revocar sesiones activas → COMMIT; ante cualquier error →
 * ROLLBACK).
 *
 * 6.3B.10 (cierre del TOCTOU de `ensureNotLastAdmin`):
 * - La invariante "siempre ≥ 1 admin" se evalúa DENTRO de la transacción,
 *   después de adquirir locks pesimistas con `SELECT … FOR UPDATE`:
 *     1. fila del usuario objetivo → serializa mutaciones del mismo usuario;
 *     2. filas `user_roles WHERE role='admin'` (orden determinista por PK para
 *        evitar deadlocks) → serializa demociones concurrentes entre distintos
 *        admins: el 2º request bloquea en el lock y re-evalúa el conteo tras
 *        el commit del 1º (READ COMMITTED re-verifica el predicado y excluye
 *        las filas ya borradas), por lo que ya no ve al admin retirado.
 * - La detección de cambio efectivo también ocurre dentro de la tx, sobre el
 *   estado real al mutar (antes se leía fuera y podía quedar stale).
 * - Si la operación dejaría 0 admins lanza el MISMO error funcional (403) que
 *   producía el check pre-transaccional; el throw aborta la tx → ROLLBACK
 *   total (roles y sesiones intactos).
 * - Además elimina el N+1 del check antiguo (listUsers + listRolesForUser por
 *   usuario): una única query sobre `user_roles` cuenta los admins.
 */
export async function setRolesAndRevokeSessions(
  sub: string,
  nextRoles: string[],
): Promise<SetRolesResult> {
  return db.transaction(async (tx) => {
    // Lock 1: fila del usuario objetivo (serializa mutaciones del mismo usuario).
    await tx
      .select({ sub: usersTable.sub })
      .from(usersTable)
      .where(eq(usersTable.sub, sub))
      .for("update");

    // Lock 2 + conteo post-lock: conjunto de admins actual. `FOR UPDATE` no
    // aplica sobre agregados → se seleccionan filas y se cuentan en JS.
    const adminRows = await tx
      .select({ userSub: userRolesTable.userSub })
      .from(userRolesTable)
      .where(eq(userRolesTable.role, "admin"))
      .orderBy(userRolesTable.userSub)
      .for("update");
    const adminSubs = new Set(adminRows.map((row) => row.userSub));

    // Invariante evaluada AL MOMENTO DE MUTAR: retirar el último admin → 403.
    if (!nextRoles.includes("admin") && adminSubs.has(sub) && adminSubs.size <= 1) {
      throw forbidden("Cannot remove the last administrator role");
    }

    // Detección de cambio efectivo DENTRO de la tx (ignora orden y duplicados).
    const currentRows = await tx
      .select({ role: userRolesTable.role })
      .from(userRolesTable)
      .where(eq(userRolesTable.userSub, sub));
    const currentRoles = currentRows.map((row) => row.role);
    const changed =
      [...currentRoles].sort().join(",") !== [...nextRoles].sort().join(",");
    if (!changed) {
      return { applied: currentRoles, changed: false, revokedSessions: 0 };
    }

    await tx.delete(userRolesTable).where(eq(userRolesTable.userSub, sub));
    if (nextRoles.length > 0) {
      await tx.insert(userRolesTable).values(
        nextRoles.map((role) => ({ userSub: sub, role })),
      );
    }
    const revokedSessions = await revokeAllSessionsForUserTx(tx, sub);
    return { applied: [...nextRoles], changed: true, revokedSessions };
  });
}