import { eq, isNull, or, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";

/**
 * M21.3 (D2) — Predicado de scoping por tenant, TRANSITORIO hasta el
 * backfill de M21.4: una fila pertenece al tenant si `tenant_id` coincide
 * con la organización activa, o si es legacy (`tenant_id IS NULL` — datos
 * previos a M21.1, aún comunes a todos los tenants por decisión de
 * compatibilidad). Cuando M21.4 complete el backfill y el NOT NULL, este
 * predicado se reduce a la igualdad exacta.
 *
 * `organizationId` SIEMPRE proviene del contexto de organización resuelto
 * server-side (`requireOrgContext`) — nunca del cliente.
 */
export function tenantScope(
  column: AnyColumn,
  organizationId: string,
): SQL | undefined {
  return or(eq(column, organizationId), isNull(column));
}
