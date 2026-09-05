import { and, eq, gt, isNull } from "drizzle-orm";
import { db, sessionsTable, usersTable, userRolesTable, type Session } from "@workspace/db";
import { decodeJwt } from "jose";

/**
 * Sesiones server-side (allowlist por `jti`). El login registra la fila con el
 * `jti` del JWT emitido; `requireAuth` exige fila activa; logout revoca.
 * `ON DELETE CASCADE` en la FK garantiza que eliminar un usuario invalida sus
 * sesiones al instante. "Activa" = no revocada y no expirada (la expiración
 * autoritativa sigue siendo la del JWT; aquí es redundancia defensiva).
 */

/**
 * [6.3B.12] Login transaccional - cierre del riesgo U3 (carrera login +
 * role-change que podia emitir un JWT con roles stale y sesion allowlist
 * activa). La sesion del JWT se crea en la MISMA transaccion que lockea la
 * fila del usuario (SELECT ... FOR UPDATE) y lee sus roles; el mismo lock
 * que setRolesAndRevokeSessions adquiere como primer paso (6.3B.10), asi
 * que ambos flujos se serializan y no puede sobrevivir un JWT stale con
 * fila activa. buildToken recibe los roles leidos dentro de la tx; ante
 * error, la transaccion hace ROLLBACK sin dejar sesion ni JWT emitido.
 */
export async function createSessionForUser(
  sub: string,
  buildToken: (roles: string[]) => Promise<string>,
): Promise<{ jwt: string; roles: string[] }> {
  return db.transaction(async (tx) => {
    // Lock 1 (mismo orden que setRolesAndRevokeSessions): fila del usuario.
    await tx
      .select({ sub: usersTable.sub })
      .from(usersTable)
      .where(eq(usersTable.sub, sub))
      .for("update");

    // Lectura de roles DENTRO de la tx, tras adquirir el lock.
    const roleRows = await tx
      .select({ role: userRolesTable.role })
      .from(userRolesTable)
      .where(eq(userRolesTable.userSub, sub));
    const roles = roleRows.map((row) => row.role);

    const jwt = await buildToken(roles);

    const { jti, exp } = decodeJwt(jwt);
    if (typeof jti !== "string" || typeof exp !== "number") {
      throw new Error("JWT without jti/exp; refusing to create session");
    }
    await tx.insert(sessionsTable).values({
      jti,
      userSub: sub,
      expiresAt: new Date(exp * 1000),
    });

    return { jwt, roles };
  });
}

/** Devuelve la sesión solo si está activa (no revocada y no expirada). */
export async function findActiveByJti(jti: string): Promise<Session | null> {
  const [row] = await db
    .select()
    .from(sessionsTable)
    .where(
      and(
        eq(sessionsTable.jti, jti),
        isNull(sessionsTable.revokedAt),
        gt(sessionsTable.expiresAt, new Date()),
      ),
    );
  return row ?? null;
}

/** Revoca la sesión si estaba activa; true si la revocación fue efectiva. */
export async function revokeByJti(jti: string): Promise<boolean> {
  const rows = await db
    .update(sessionsTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessionsTable.jti, jti), isNull(sessionsTable.revokedAt)))
    .returning({ jti: sessionsTable.jti });
  return rows.length > 0;
}

/**
 * Variante transaccional: revoca todas las sesiones activas de un usuario
 * dentro de una transacción ya abierta (`tx`). Permite componer operaciones
 * atómicas (p. ej. cambio de roles + revocación) sin abrir una transacción
 * anidada: ante cualquier error, la transacción hace ROLLBACK y devuelve
 * sesiones y roles al estado previo.
 */
export async function revokeAllSessionsForUserTx(
  tx: Pick<typeof db, "update">,
  userSub: string,
): Promise<number> {
  const rows = await tx
    .update(sessionsTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessionsTable.userSub, userSub), isNull(sessionsTable.revokedAt)))
    .returning({ jti: sessionsTable.jti });
  return rows.length;
}

