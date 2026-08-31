import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Fuentes de datos monitoreadas por la plataforma.
 *
 * `kind`, `environment` y `status` se almacenan como texto: el dominio válido
 * vive en los contratos Zod de `@workspace/api-zod` (fuente de verdad generada
 * desde `lib/api-spec/openapi.yaml`), lo que evita `ALTER TYPE` en la BD al
 * evolucionar el catálogo.
 */
export const sourcesTable = pgTable("sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  environment: text("environment").notNull(),
  status: text("status").notNull(),
  lastScanAt: timestamp("last_scan_at", { withTimezone: true }),
  tables: integer("tables").notNull(),
  records: integer("records").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSourceSchema = createInsertSchema(sourcesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Source = typeof sourcesTable.$inferSelect;
export type InsertSource = z.infer<typeof insertSourceSchema>;
