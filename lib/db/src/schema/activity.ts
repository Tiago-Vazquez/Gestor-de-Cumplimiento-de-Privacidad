import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

/**
 * Eventos de actividad recientes mostrados en el dashboard.
 *
 * `type` y `severity` se almacenan como texto (dominio validado por los
 * contratos ActivityType / ActivitySeverity de `@workspace/api-zod`);
 * `severity` es nulo para eventos que no corresponden a un hallazgo.
 */
export const activityTable = pgTable("activity", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  severity: text("severity"),
  // M21.1 (ADR-001): raíz independiente (feed del dashboard, sin FK a
  // sources/users) → tenant_id propio, derivado del recurso que originó el
  // evento en el punto de inserción. Nullable TRANSITORIO: backfill en
  // M21.4 → NOT NULL.
  tenantId: text("tenant_id").references(() => organizationsTable.id),
}, (table) => [
  // M21.1 (ADR-001): único patrón de consulta del repo — feed por tenant
  // ordenado por creación DESC (`activity.repo.list` ya ordena created_at DESC).
  index("activity_tenant_created_idx").on(table.tenantId, table.createdAt),
]);

export const insertActivitySchema = createInsertSchema(activityTable).omit({
  id: true,
});

export type Activity = typeof activityTable.$inferSelect;
export type InsertActivity = z.infer<typeof insertActivitySchema>;
