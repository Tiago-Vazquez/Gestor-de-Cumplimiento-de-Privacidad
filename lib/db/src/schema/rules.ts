import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Catálogo de reglas de detección de información sensible.
 *
 * `lastTriggered` es nulo cuando la regla nunca se ha disparado; el mapeador
 * de la capa API lo traduce al literal "Nunca" que espera el contrato.
 */
export const rulesTable = pgTable("rules", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  regulation: text("regulation").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  detections: integer("detections").notNull().default(0),
  lastTriggered: timestamp("last_triggered", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRuleSchema = createInsertSchema(rulesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Rule = typeof rulesTable.$inferSelect;
export type InsertRule = z.infer<typeof insertRuleSchema>;
