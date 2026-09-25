import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { hashPassword } from "@workspace/auth";
import {
  membershipsTable,
  organizationsTable,
  userRolesTable,
  usersTable,
} from "./schema";

/**
 * M22 (P0-2) — Provisioning del PRIMER administrador (fuera del flujo HTTP).
 *
 * Sustituye al bootstrap legacy (`AUTH_BOOTSTRAP_TOKEN` / identidad fija
 * `bootstrap-admin`): una instalación nueva crea su primera organización y su
 * primer administrador con una operación administrativa EXPLÍCITA, ejecutada
 * por quien posee la conexión de superusuario (`ADMIN_DATABASE_URL` → privacy).
 *
 * Flujo:
 *   instalación nueva → `pnpm --filter @workspace/db run db:provision-admin`
 *     → crea organización + usuario admin (con hash scrypt) + rol global admin
 *       + membership `owner` → login normal (email + password).
 *
 * - Idempotente: re-ejecutable sin duplicar (organización por id determinístico,
 *   usuario por email, rol/membership con ON CONFLICT DO NOTHING).
 * - El password viaja SOLO por variable de entorno (`PROVISION_ADMIN_PASSWORD`)
 *   y se hashea con scrypt (mismo formato que verifica `@workspace/auth`).
 * - NUNCA se loguea el password; solo email / sub / slug.
 *
 * Autoridad: quien ejecuta este script debe poder leer la conexión de
 * superusuario. No existe ninguna identidad privilegiada fija ni token estático.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`${name} is required for admin provisioning (fail-closed)`);
  }
  return value;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "default";
}

async function main(): Promise<void> {
  const adminUrl = requireEnv("ADMIN_DATABASE_URL");
  const email = requireEnv("PROVISION_ADMIN_EMAIL").toLowerCase();
  const password = requireEnv("PROVISION_ADMIN_PASSWORD");
  const name = process.env.PROVISION_ADMIN_NAME?.trim() || null;
  const orgName = process.env.PROVISION_ORG_NAME?.trim() || "Default Organization";
  const orgSlug = slugify(process.env.PROVISION_ORG_SLUG || orgName);
  const orgId = `org-${orgSlug}`;

  if (password.length < 12) {
    throw new Error("PROVISION_ADMIN_PASSWORD must be at least 12 characters");
  }

  const pool = new pg.Pool({ connectionString: adminUrl });
  const db = drizzle(pool, { schema: { organizationsTable, usersTable, userRolesTable, membershipsTable } });

  try {
    const passwordHash = await hashPassword(password);

    await db.transaction(async (tx) => {
      // 1. Organización inicial (id determinístico → idempotente).
      await tx
        .insert(organizationsTable)
        .values({ id: orgId, name: orgName, slug: orgSlug, status: "active" })
        .onConflictDoNothing({ target: organizationsTable.id });

      // 2. Usuario admin (idempotente por email: reutiliza el sub existente).
      const [existing] = await tx
        .select({ sub: usersTable.sub })
        .from(usersTable)
        .where(eq(usersTable.email, email))
        .limit(1);
      const sub = existing?.sub ?? randomUUID();

      await tx
        .insert(usersTable)
        .values({ sub, email, name, passwordHash })
        .onConflictDoUpdate({
          target: usersTable.sub,
          set: { email, name, passwordHash },
        });

      // 3. Rol global admin (necesario para la superficie de plataforma).
      await tx
        .insert(userRolesTable)
        .values({ userSub: sub, role: "admin" })
        .onConflictDoNothing();

      // 4. Membership `owner` en la organización inicial.
      await tx
        .insert(membershipsTable)
        .values({ organizationId: orgId, userSub: sub, role: "owner" })
        .onConflictDoNothing();
    });

    console.log(`Provisioned first admin: ${email} (sub from DB, org "${orgSlug}")`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error("admin provisioning failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
