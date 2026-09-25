import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

/**
 * M21.1 — Memberships: relación user ↔ organization.
 *
 * El ROL pertenece al membership (por organización), NO al usuario global: una
 * persona puede ser `admin` en una organización y `auditor` en otra. La PK
 * compuesta (organization_id, user_sub) — misma estrategia que `user_roles`
 * (user_sub, role) — garantiza a nivel BD que no exista un membership
 * duplicado para el mismo par.
 *
 * Roles MVP: `owner | admin | auditor | member` (CHECK de defensa en
 * profundidad). `owner` se asigna por transferencia/bootstrap, no por
 * invitación (ver CHECK de `invitations`).
 *
 * Compatibilidad (ADR-001): `user_roles` (roles globales) NO se elimina en
 * M21.1; permanece activo hasta M21.2/M21.4, cuando la autorización migre a
 * memberships y el backfill convierta los roles existentes.
 *
 * FKs reales: organización y usuario con CASCADE (borrar una org o un usuario
 * elimina sus memberships, mismo criterio que `sessions.user_sub`);
 * `invited_by` con SET NULL (la invitación es contexto, no identidad — el
 * histórico de auditoría conserva el actor por separado).
 */
export const membershipsTable = pgTable(
  "memberships",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userSub: text("user_sub")
      .notNull()
      .references(() => usersTable.sub, { onDelete: "cascade" }),
    role: text("role").notNull(),
    invitedBy: text("invited_by").references(() => usersTable.sub, { onDelete: "set null" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userSub] }),
    // Listar las organizaciones de un usuario (selector de org, M21.2/M21.6).
    // El caso inverso (miembros de una org) queda cubierto por la PK compuesta.
    index("memberships_user_sub_idx").on(table.userSub),
    check(
      "memberships_role_check",
      sql`${table.role} in ('owner', 'admin', 'auditor', 'member')`,
    ),
  ],
);

export const insertMembershipSchema = createInsertSchema(membershipsTable).omit({
  joinedAt: true,
});

export type Membership = typeof membershipsTable.$inferSelect;
export type InsertMembership = z.infer<typeof insertMembershipSchema>;