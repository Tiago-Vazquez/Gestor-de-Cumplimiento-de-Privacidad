import { and, desc, eq, gte, isNull, lte, type SQL } from "drizzle-orm";
import { auditEventsTable, db, type AuditEvent } from "@workspace/db";
import type { Pagination } from "../lib/pagination";
import { tenantScopeStrict } from "./tenant";

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
  /**
   * M21.3 (ADR-001) — tenant del evento, resuelto en el punto de registro:
   * actor → organización activa; eventos de sistema → NULL (la resolución
   * por recurso afectado llega con el backfill de M21.4).
   */
  tenantId?: string | null;
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
      tenantId: input.tenantId ?? null,
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
  /** M21.7 — scoping ESTRICTO obligatorio por tenant. */
  tenantId: string;
};

/**
 * M21.7.3 — filtros del endpoint de auditoría de PLATAFORMA. Igual que
 * `AuditEventFilters` pero SIN `tenantId`: el scoping es fijo (`tenant_id IS
 * NULL`), nunca aportado por el llamador.
 */
export type AuditEventPlatformFilters = Omit<AuditEventFilters, "tenantId">;

/**
 * Predicados de filtro comunes a `list` y `listPlatform` (actor, acción,
 * recurso, resultado y rango temporal). NO incluyen scoping de tenant: cada
 * método añade el suyo (`tenantScopeStrict` vs `isNull(tenantId)`), para que
 * ningún cambio aquí introduzca tenant scoping accidental en el endpoint de
 * plataforma.
 */
function buildSharedAuditFilters(filters: AuditEventPlatformFilters): SQL[] {
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
  return conditions;
}

export async function list(
  filters: AuditEventFilters,
  pagination?: Pagination,
): Promise<AuditEvent[]> {
  const conditions = buildSharedAuditFilters(filters);
  // M21.7 — scoping ESTRICTO obligatorio por tenant.
  conditions.push(tenantScopeStrict(auditEventsTable.tenantId, filters.tenantId));

  let query = db
    .select()
    .from(auditEventsTable)
    .where(and(...conditions))
    .orderBy(desc(auditEventsTable.createdAt), desc(auditEventsTable.id))
    .$dynamic();
  if (pagination) {
    query = query.limit(pagination.limit).offset(pagination.offset);
  }
  return query;
}

/**
 * M21.7.3 — listado de eventos de PLATAFORMA: SOLO `tenant_id IS NULL`.
 * Conjunto disjunto de `list` (que devuelve `tenant_id = org`). No acepta
 * `tenantId` por contrato.
 */
export async function listPlatform(
  filters: AuditEventPlatformFilters,
  pagination?: Pagination,
): Promise<AuditEvent[]> {
  const conditions = buildSharedAuditFilters(filters);
  // M21.7.3 — exclusivamente eventos de plataforma (sin organización).
  conditions.push(isNull(auditEventsTable.tenantId));

  let query = db
    .select()
    .from(auditEventsTable)
    .where(and(...conditions))
    .orderBy(desc(auditEventsTable.createdAt), desc(auditEventsTable.id))
    .$dynamic();
  if (pagination) {
    query = query.limit(pagination.limit).offset(pagination.offset);
  }
  return query;
}