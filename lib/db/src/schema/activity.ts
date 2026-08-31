import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

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
});

export const insertActivitySchema = createInsertSchema(activityTable).omit({
  id: true,
});

export type Activity = typeof activityTable.$inferSelect;
export type InsertActivity = z.infer<typeof insertActivitySchema>;
