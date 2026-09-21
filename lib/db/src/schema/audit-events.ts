import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * M17 — Auditoría y trazabilidad administrativa (`audit_events`).
 *
 * Responde "¿quién hizo qué, cuándo y sobre qué recurso?": cada evento
 * identifica al actor autenticado (`actor_user_id`, null para acciones
 * internas), la acción (`action`), el recurso (`resource_type` + `resource_id`),
 * el resultado (`success` | `failure`), el correlation id del request (M16,
 * `request_id`, null en acciones internas) y `metadata` con SOLO información
 * operacional segura (ids, contadores, tipos, estados).
 *
 * Decisiones de diseño:
 * - SIN foreign key a `users`: el histórico de auditoría debe sobrevivir a
 *   cualquier cambio/borrado futuro de cuentas (retención, no integridad).
 * - `metadata` es JSONB y NUNCA contiene passwords, JWT, cookies, tokens CSRF,
 *   claves de cifrado, credenciales de conexión ni datos descubiertos por
 *   scans (la defensa vive en los puntos de registro, no en la tabla).
 * - Índices para las consultas administrativas: actor, fecha, recurso
 *   compuesto y acción.
 */
export const auditEventsTable = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    result: text("result").notNull(),
    requestId: text("request_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_actor_user_id_idx").on(table.actorUserId),
    index("audit_events_created_at_idx").on(table.createdAt),
    index("audit_events_resource_idx").on(table.resourceType, table.resourceId),
    index("audit_events_action_idx").on(table.action),
  ],
);

export type AuditEvent = typeof auditEventsTable.$inferSelect;
export type InsertAuditEvent = typeof auditEventsTable.$inferInsert;