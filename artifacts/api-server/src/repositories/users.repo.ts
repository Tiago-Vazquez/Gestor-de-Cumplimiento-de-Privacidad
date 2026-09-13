import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { db, sessionsTable, usersTable, type User } from "@workspace/db";
import type { Pagination } from "../lib/pagination";

export async function getBySub(sub: string): Promise<User | null> {
  const [row] = await db.select().from(usersTable).where(eq(usersTable.sub, sub));
  return row ?? null;
}

export async function getByEmail(email: string): Promise<User | null> {
  const [row] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  return row ?? null;
}

/**
 * Alta o actualización de un usuario a partir del identificador estable (`sub`)
 * que emitirá el proveedor de identidad. Si el `sub` ya existe se refrescan
 * email/nombre; la PK impide duplicar la persona.
 */
export async function upsertBySub(values: {
  sub: string;
  email: string;
  name: string | null;
}): Promise<User> {
  const [row] = await db
    .insert(usersTable)
    .values({
      sub: values.sub,
      email: values.email,
      name: values.name,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: usersTable.sub,
      set: { email: values.email, name: values.name, updatedAt: new Date() },
    })
    .returning();
  return row;
}

/** Actualiza el hash de contraseña de un usuario. */
export async function updatePasswordHash(
  sub: string,
  passwordHash: string,
): Promise<void> {
  await db
    .update(usersTable)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(usersTable.sub, sub));
}

/**
 * Cambio de contraseña autenticado (M11.2.1), atómico con la invalidación de
 * sesiones. En una MISMA transacción:
 *  1. lockea la fila del usuario (mismo orden de locks que createSessionForUser
 *     y setRolesAndRevokeSessions: users(sub) → sessions, evita deadlock);
 *  2. actualiza el password hash;
 *  3. revoca todas las sesiones activas del usuario EXCEPTO `exceptJti` (la
 *     sesión desde la que se realizó el cambio, que debe seguir válida).
 *
 * Ante cualquier error la transacción hace ROLLBACK: no queda hash nuevo con
 * sesiones viejas activas ni hash viejo con sesiones ya revocadas. Devuelve el
 * número de sesiones revocadas (0 si no había otras).
 */
export async function changePasswordAndRevokeOtherSessions(
  sub: string,
  passwordHash: string,
  exceptJti: string | null,
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx
      .select({ sub: usersTable.sub })
      .from(usersTable)
      .where(eq(usersTable.sub, sub))
      .for("update");

    await tx
      .update(usersTable)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(usersTable.sub, sub));

    const conditions = [
      eq(sessionsTable.userSub, sub),
      isNull(sessionsTable.revokedAt),
    ];
    if (exceptJti) conditions.push(ne(sessionsTable.jti, exceptJti));

    const rows = await tx
      .update(sessionsTable)
      .set({ revokedAt: new Date() })
      .where(and(...conditions))
      .returning({ jti: sessionsTable.jti });
    return rows.length;
  });
}

/** Actualiza el timestamp del último login exitoso. */
export async function updateLastLogin(sub: string): Promise<void> {
  await db
    .update(usersTable)
    .set({ lastLoginAt: new Date() })
    .where(eq(usersTable.sub, sub));
}

/**
 * Lista usuarios (uso administrativo; nunca expone passwordHash).
 * F4 (6.3B.20): paginación en SQL; orden estable por creación + sub.
 */
export async function listUsers(pagination?: Pagination): Promise<User[]> {
  let query = db
    .select()
    .from(usersTable)
    .orderBy(asc(usersTable.createdAt), asc(usersTable.sub))
    .$dynamic();
  if (pagination) {
    query = query.limit(pagination.limit).offset(pagination.offset);
  }
  return query;
}

/**
 * Actualiza los campos administrativos permitidos (email/name) de un usuario.
 * `sub` NO es modificable: es la identidad estable del usuario.
 */
export async function updateProfile(
  sub: string,
  values: { email?: string; name?: string | null },
): Promise<User | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (values.email !== undefined) set.email = values.email;
  if (values.name !== undefined) set.name = values.name;
  const [row] = await db
    .update(usersTable)
    .set(set)
    .where(eq(usersTable.sub, sub))
    .returning();
  return row ?? null;
}