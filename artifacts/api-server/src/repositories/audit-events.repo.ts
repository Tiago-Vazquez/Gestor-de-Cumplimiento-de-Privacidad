import { and, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import { auditEventsTable, db, type AuditEvent } from "@workspace/db";
import type { Pagination } from "../lib/pagination";

/**
 * M17 — Repositorio de auditoría administrativa (`audit_events`).
 *
 * - `create`: inserta el evento (los llamadores lo usan best-effort vía
 *   `lib/audit.ts`; un fallo de auditoría nunca debe romper la acción).
 * - `list`: consulta paginada EN SQL (LIMIT/OFFSET, F4 6.3B.20) con filtros
 *   opcionales (actor, acción, recurso, resultado, rango temporal), orden
 *   `created_at DESC` (y `id DESC` como desempate estable). Nunca devuelve la
 *   tabla completa sin límite.
 */

export type AuditEventCreateInput = {
  id: string;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  result: string;
  requestId: string | null;
  metadata: Record<string, unknown>;
};

export async function create(input: AuditEventCreateInput): Promise<AuditEvent> {
  const [row] = await db
    .insert(auditEventsTable)
    .values({
      id: input.id,
      actorUserId: input.actorUserId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      result: input.result,
      requestId: input.requestId,
      metadata: input.metadata,
    })
    .returning();
  return row;
}

export type AuditEventFilters = {
  actorUserId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  result?: string;
  from?: Date;
  to?: Date;
};

export async function list(
  filters: AuditEventFilters = {},
  pagination?: Pagination,
): Promise<AuditEvent[]> {
  const conditions: SQL[] = [];
  if (filters.actorUserId !== undefined) {
    conditions.push(eq(auditEventsTable.actorUserId, filters.actorUserId));
  }
  if (filters.action !== undefined) {
    conditions.push(eq(auditEventsTable.action, filters.action));
  }
  if (filters.resourceType !== undefined) {
    conditions.push(eq(auditEventsTable.resourceType, filters.resourceType));
  }
  if (filters.resourceId !== undefined) {
    conditions.push(eq(auditEventsTable.resourceId, filters.resourceId));
  }
  if (filters.result !== undefined) {
    conditions.push(eq(auditEventsTable.result, filters.result));
  }
  if (filters.from !== undefined) {
    conditions.push(gte(auditEventsTable.createdAt, filters.from));
  }
  if (filters.to !== undefined) {
    conditions.push(lte(auditEventsTable.createdAt, filters.to));
  }

  let query = db
    .select()
    .from(auditEventsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditEventsTable.createdAt), desc(auditEventsTable.id))
    .$dynamic();
  if (pagination) {
    query = query.limit(pagination.limit).offset(pagination.offset);
  }
  return query;
}