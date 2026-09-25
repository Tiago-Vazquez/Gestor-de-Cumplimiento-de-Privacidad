import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

/**
 * Fuentes de datos monitoreadas por la plataforma.
 *
 * `kind`, `environment` y `status` se almacenan como texto: el dominio válido
 * vive en los contratos Zod de `@workspace/api-zod` (fuente de verdad generada
 * desde `lib/api-spec/openapi.yaml`), lo que evita `ALTER TYPE` en la BD al
 * evolucionar el catálogo.
 *
 * FASE 7.0.0: `connectionConfig` almacena la configuración de conexión cifrada
 * (AES-256-GCM) para fuentes PostgreSQL externas. Es NULL para fuentes legacy
 * que no tienen configuración de conexión (solo metadatos).
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
  connectionConfig: jsonb("connection_config"),
  // M21.1 (ADR-001): raíz de propiedad de los recursos de negocio. Nullable
  // TRANSITORIO: el backfill real lo asigna en M21.4 y entonces pasa a NOT
  // NULL (el esquema no puede garantizarlo antes sin bloquear filas
  // existentes). FK RESTRICT: borrar una organización no debe arrastrar datos
  // de negocio (las orgs no se eliminan en MVP; la restricción lo impide).
  tenantId: text("tenant_id").notNull().references(() => organizationsTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // M21.1 (ADR-001): patrón dominante WHERE tenant_id = ? (listado por org en
  // M21.3 y agregaciones del dashboard: COUNT/SUM por organización).
  index("sources_tenant_id_idx").on(table.tenantId),
]);

export const insertSourceSchema = createInsertSchema(sourcesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Source = typeof sourcesTable.$inferSelect;
export type InsertSource = z.infer<typeof insertSourceSchema>;
