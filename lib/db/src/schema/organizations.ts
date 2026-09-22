import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * M21.1 — Organizations: boundary de tenant de la plataforma.
 *
 * Cada organización es el límite de aislamiento de los recursos de negocio
 * (sources, findings, reports, activity, audit_events — ADR-001). `slug` es el
 * identificador estable para URLs (único, en minúsculas, validado a nivel API);
 * la unicidad vive en la BD como segunda línea de defensa, igual que
 * `users.email`.
 *
 * Decisiones MVP (ADR-001):
 * - `status` con CHECK de defensa en profundidad (`active | suspended`), al
 *   estilo del CHECK de `user_roles`: el dominio razonable se garantiza en la
 *   BD, no solo en la API.
 * - Sin `updated_at`: no hay operación de actualización definida todavía en
 *   MVP (el renombrado/suspensión llegará con la administración de M21.2); se
 *   añadirá entonces, igual que se añadió a otras tablas al crecer su dominio.
 * - El id sigue la convención del proyecto (`text` con prefijo, p. ej. `org-…`
 *   vía `newId("org")`), sin semántica de identidad externa.
 */
export const organizationsTable = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("organizations_slug_key").on(table.slug),
    check("organizations_status_check", sql`${table.status} in ('active', 'suspended')`),
  ],
);

export const insertOrganizationSchema = createInsertSchema(organizationsTable).omit({
  createdAt: true,
});

export type Organization = typeof organizationsTable.$inferSelect;
export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;