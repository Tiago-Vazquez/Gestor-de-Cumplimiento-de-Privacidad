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