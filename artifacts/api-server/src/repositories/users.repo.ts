import { eq } from "drizzle-orm";
import { db, usersTable, type User } from "@workspace/db";

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

/** Actualiza el timestamp del último login exitoso. */
export async function updateLastLogin(sub: string): Promise<void> {
  await db
    .update(usersTable)
    .set({ lastLoginAt: new Date() })
    .where(eq(usersTable.sub, sub));
}

/** Lista todos los usuarios (uso administrativo; nunca expone passwordHash). */
export async function listUsers(): Promise<User[]> {
  return db.select().from(usersTable).orderBy(usersTable.createdAt);
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