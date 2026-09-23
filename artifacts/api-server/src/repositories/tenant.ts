import { eq, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";

/**
 * M21.5 — Predicado de scoping ESTRICTO por tenant. Una fila pertenece al
 * tenant SOLO si `tenant_id` coincide con la organización activa. El fallback
 * transitorio `tenant_id IS NULL` (D2 de M21.3) queda RETIRADO: M21.4
 * backfilleó las filas y aplicó NOT NULL en las tablas de negocio, y los
 * `audit_events` con `tenant_id IS NULL` son eventos de plataforma que NO se
 * muestran en listados org-scoped.
 *
 * `organizationId` SIEMPRE proviene del contexto de organización resuelto
 * server-side (`resolvedOrgContext`) — nunca del cliente.
 */
export function tenantScopeStrict(
  column: AnyColumn,
  organizationId: string,
): SQL {
  if (!organizationId) {
    throw new Error(
      "tenantScopeStrict requires a non-empty organizationId; refusing to build an unscoped query",
    );
  }
  return eq(column, organizationId);
}
