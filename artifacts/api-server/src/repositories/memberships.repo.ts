import { and, asc, eq, inArray } from "drizzle-orm";
import { db, membershipsTable, organizationsTable, usersTable } from "@workspace/db";
import { forbidden, notFound, AppError } from "../lib/errors";
import { clearActiveOrgForOrgTx, revokeAllSessionsForUserTx } from "./sessions.repo";

/**
 * M21.2 — Memberships: la AUTORIDAD EMPRESARIAL (ADR-002).
 *
 * El rol vive en la relación user ↔ organization, no en el usuario global.
 * `user_roles` (roles globales admin|auditor) sigue activo SOLO para la
 * plataforma (admin de usuarios) durante la transición hasta M21.4; la
 * autorización de negocio empieza aquí.
 *
 * Invariantes (misma técnica que `setRolesAndRevokeSessions`, 6.3B.10):
 * - Todo cambio/eliminación corre en UNA transacción con locks `FOR UPDATE`
 *   (fila del target + filas owner/admin de la org, orden determinista por
 *   PK anti-deadlock) y evalúa la invariante AL MOMENTO DE MUTAR: la
 *   organización nunca queda sin `owner` y nunca sin ningún `owner|admin`.
 * - `owner` NO es editable ni removible vía API en M21.2 (la transferencia
 *   de propiedad es una operación explícita futura; improvisar un cambio de
 *   string dejaría la org sin owner).
 * - Ante cualquier cambio/eliminación se revocan TODAS las sesiones del
 *   usuario afectado y se limpia su contexto activo para esa org (misma tx):
 *   un JWT antiguo no conserva acceso empresarial.
 */

export type OrgRole = "owner" | "admin" | "auditor" | "member";
export const ORG_ROLES: readonly OrgRole[] = ["owner", "admin", "auditor", "member"];
/** Roles con capacidad de gobierno (invariante de existencia). */
const ADMIN_CAPABLE: readonly OrgRole[] = ["owner", "admin"];
/** Roles asignables/removibles vía API (owner solo por transferencia futura). */
export const ASSIGNABLE_ROLES: readonly Exclude<OrgRole, "owner">[] = [
  "admin",
  "auditor",
  "member",
];

export type Membership = typeof membershipsTable.$inferSelect;

function memberNotFound(): AppError {
  // 404 uniforme: no filtra si el sub existe en otra organización.
  // AppError (y no un Error crudo con `status`): el error handler central solo
  // mapea AppError a problem+json; un error desconocido caería como 500.
  return notFound("Member not found");
}

export async function getByUserAndOrg(
  userSub: string,
  organizationId: string,
): Promise<Membership | null> {
  const [row] = await db
    .select()
    .from(membershipsTable)
    .where(
      and(
        eq(membershipsTable.userSub, userSub),
        eq(membershipsTable.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Primera organización del usuario (orden de ingreso): default del login. */
export async function getFirstOrgForUser(userSub: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: membershipsTable.organizationId })
    .from(membershipsTable)
    .where(eq(membershipsTable.userSub, userSub))
    .orderBy(asc(membershipsTable.joinedAt), asc(membershipsTable.organizationId))
    .limit(1);
  return row?.organizationId ?? null;
}

/** Organizaciones del usuario + rol (selector de M21.6). Orden de ingreso. */
export async function listByUser(
  userSub: string,
): Promise<
  {
    organization: { id: string; name: string; slug: string; createdAt: Date };
    role: string;
    joinedAt: Date;
  }[]
> {
  const rows = await db
    .select({
      organization: {
        id: organizationsTable.id,
        name: organizationsTable.name,
        slug: organizationsTable.slug,
        createdAt: organizationsTable.createdAt,
      },
      role: membershipsTable.role,
      joinedAt: membershipsTable.joinedAt,
    })
    .from(membershipsTable)
    .innerJoin(organizationsTable, eq(membershipsTable.organizationId, organizationsTable.id))
    .where(eq(membershipsTable.userSub, userSub))
    .orderBy(asc(membershipsTable.joinedAt), asc(membershipsTable.organizationId));
  return rows;
}

/** Miembros de una organización con identidad pública (sin credenciales). */
export async function listByOrg(
  organizationId: string,
): Promise<{ sub: string; email: string; name: string | null; role: string; joinedAt: Date }[]> {
  const rows = await db
    .select({
      sub: usersTable.sub,
      email: usersTable.email,
      name: usersTable.name,
      role: membershipsTable.role,
      joinedAt: membershipsTable.joinedAt,
    })
    .from(membershipsTable)
    .innerJoin(usersTable, eq(membershipsTable.userSub, usersTable.sub))
    .where(eq(membershipsTable.organizationId, organizationId))
    .orderBy(asc(membershipsTable.joinedAt), asc(membershipsTable.userSub));
  return rows;
}

/**
 * Crea un membership (idempotente por PK compuesta). `null` = ya existía.
 * El alta por invitación usa `consumeByTokenHash` (transaccional); esto queda
 * para el flujo bootstrap.
 */
export async function create(values: {
  organizationId: string;
  userSub: string;
  role: OrgRole;
  invitedBy?: string | null;
}): Promise<Membership | null> {
  const [row] = await db
    .insert(membershipsTable)
    .values({
      organizationId: values.organizationId,
      userSub: values.userSub,
      role: values.role,
      invitedBy: values.invitedBy ?? null,
    })
    .onConflictDoNothing({ target: [membershipsTable.organizationId, membershipsTable.userSub] })
    .returning();
  return row ?? null;
}

export type MutateMembershipResult = { revokedSessions: number };

/**
 * Cambia el rol de un miembro (owner|admin). `owner` inmutable; la org debe
 * conservar ≥1 owner|admin tras el cambio; revoca sesiones del afectado.
 */
export async function updateRole(
  organizationId: string,
  userSub: string,
  nextRole: (typeof ASSIGNABLE_ROLES)[number],
): Promise<MutateMembershipResult> {
  return db.transaction(async (tx) => {
    // Lock 1: fila del target (serializa mutaciones del mismo usuario).
    const [target] = await tx
      .select()
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.organizationId, organizationId),
          eq(membershipsTable.userSub, userSub),
        ),
      )
      .for("update");
    if (!target) throw memberNotFound();
    if (target.role === "owner") {
      throw forbidden("Ownership transfer is required to change the owner membership");
    }
    if (target.role === nextRole) {
      // No-op efectivo: sin revocaciones (misma filosofía que setRoles).
      return { revokedSessions: 0 };
    }

    // Lock 2 + conteo post-lock: gobierno actual de la org (orden por PK).
    const governors = await tx
      .select({ userSub: membershipsTable.userSub })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.organizationId, organizationId),
          inArray(membershipsTable.role, [...ADMIN_CAPABLE]),
        ),
      )
      .orderBy(asc(membershipsTable.userSub))
      .for("update");
    const remainingGovernors = new Set(governors.map((row) => row.userSub));
    remainingGovernors.delete(userSub);
    if (ADMIN_CAPABLE.includes(target.role as OrgRole) && remainingGovernors.size === 0) {
      throw forbidden("Cannot remove the last organization admin");
    }

    await tx
      .update(membershipsTable)
      .set({ role: nextRole })
      .where(
        and(
          eq(membershipsTable.organizationId, organizationId),
          eq(membershipsTable.userSub, userSub),
        ),
      );

    // Invalidación inmediata: sesión muere + contexto de esa org se limpia.
    const revokedSessions = await revokeAllSessionsForUserTx(tx, userSub);
    await clearActiveOrgForOrgTx(tx, userSub, organizationId);
    return { revokedSessions };
  });
}

/**
 * Elimina un membership (owner|admin). `owner` inremovible; la org debe
 * conservar ≥1 owner|admin tras la baja; revoca sesiones del afectado.
 */
export async function remove(
  organizationId: string,
  userSub: string,
): Promise<MutateMembershipResult> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.organizationId, organizationId),
          eq(membershipsTable.userSub, userSub),
        ),
      )
      .for("update");
    if (!target) throw memberNotFound();
    if (target.role === "owner") {
      throw forbidden("Ownership transfer is required to remove the owner membership");
    }

    const governors = await tx
      .select({ userSub: membershipsTable.userSub })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.organizationId, organizationId),
          inArray(membershipsTable.role, [...ADMIN_CAPABLE]),
        ),
      )
      .orderBy(asc(membershipsTable.userSub))
      .for("update");
    const remainingGovernors = new Set(governors.map((row) => row.userSub));
    remainingGovernors.delete(userSub);
    if (ADMIN_CAPABLE.includes(target.role as OrgRole) && remainingGovernors.size === 0) {
      throw forbidden("Cannot remove the last organization admin");
    }

    await tx
      .delete(membershipsTable)
      .where(
        and(
          eq(membershipsTable.organizationId, organizationId),
          eq(membershipsTable.userSub, userSub),
        ),
      );

    const revokedSessions = await revokeAllSessionsForUserTx(tx, userSub);
    await clearActiveOrgForOrgTx(tx, userSub, organizationId);
    return { revokedSessions };
  });
}
