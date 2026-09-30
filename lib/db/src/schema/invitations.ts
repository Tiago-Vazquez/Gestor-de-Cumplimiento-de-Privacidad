import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

/**
 * M21.1 — Invitaciones: SOLO el modelo de persistencia.
 *
 * M21.1 crea la tabla; los endpoints, el envío, la aceptación y la UI llegan
 * con M21.2 (que consumirá este modelo). No hay lógica de negocio aquí.
 *
 * Decisiones:
 * - `token_hash` almacena SOLO el hash del token (nunca el token en claro):
 *   el índice único habilita el lookup por hash en el flujo de aceptación.
 * - `role` del INVITE restringido a `admin | auditor | member`: la propiedad
 *   (`owner`) se transfiere explícitamente, nunca se regala por invitación
 *   (CHECK de defensa en profundidad).
 * - Unicidad SOLO por token: puede existir más de una invitación pendiente
 *   para el mismo email/org (re-invitación tras expiración); el control de
 *   duplicados pendientes es política de la capa API (M21.2).
 * - `invited_by` con SET NULL (mismo criterio que memberships).
 */
export const invitationsTable = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    invitedBy: text("invited_by").references(() => usersTable.sub, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("invitations_token_hash_key").on(table.tokenHash),
    // Gestión de invitaciones por organización + búsqueda por email (M21.2).
    index("invitations_org_email_idx").on(table.organizationId, table.email),
    check(
      "invitations_role_check",
      sql`${table.role} in ('admin', 'auditor', 'member')`,
    ),
  ],
);

export const insertInvitationSchema = createInsertSchema(invitationsTable).omit({
  createdAt: true,
});

export type Invitation = typeof invitationsTable.$inferSelect;
export type InsertInvitation = z.infer<typeof insertInvitationSchema>;