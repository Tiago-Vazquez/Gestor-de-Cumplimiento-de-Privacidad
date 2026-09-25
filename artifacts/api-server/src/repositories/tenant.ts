import { eq, sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { db } from "@workspace/db";

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

/**
 * M21.8 — Handle transaccional de drizzle (el `tx` de `db.transaction`).
 */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * M21.8 — Fija el tenant context de la transacción actual de forma
 * TRANSACTION-LOCAL. Usa `set_config(..., true)` que es el equivalente seguro
 * a `SET LOCAL` (a diferencia de `SET`, que persistiría en la conexión del
 * pool y filtraría entre requests). El `true` garantiza limpieza automática en
 * COMMIT/ROLLBACK.
 *
 * Fail-closed: lanza ante `tenantId` vacío/undefined/null.
 */
export async function setTenantLocal(tx: DbTx, tenantId: string): Promise<void> {
  if (!tenantId) {
    throw new Error(
      "setTenantLocal requires a non-empty tenantId; refusing to run an unscoped transaction",
    );
  }
  await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
}

/**
 * M21.8 — Envuelve una operación tenant-scoped en una transacción corta con
 * `set_config('app.tenant_id', ..., true)` (transaction-local). La operación
 * recibe `tx` y DEBE usar ese handle (no `db`) para que la query corra en la
 * MISMA conexión donde está seteado el tenant context.
 *
 * - Abre transacción, fija tenant, ejecuta `fn(tx)`, COMMIT si éxito.
 * - ROLLBACK automático ante error.
 * - Fail-closed ante `tenantId` vacío/undefined/null.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  if (!tenantId) {
    throw new Error(
      "withTenant requires a non-empty tenantId; refusing to run an unscoped transaction",
    );
  }
  return db.transaction(async (tx) => {
    await setTenantLocal(tx, tenantId);
    return fn(tx);
  });
}
