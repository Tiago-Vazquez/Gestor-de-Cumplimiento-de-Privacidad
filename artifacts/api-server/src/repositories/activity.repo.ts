import { desc } from "drizzle-orm";
import { activityTable, type Activity } from "@workspace/db";
import type { Pagination } from "../lib/pagination";
import { tenantScopeStrict, withTenant } from "./tenant";

/** F4 (6.3B.20): paginación aplicada en SQL (LIMIT/OFFSET), orden estable. */
export async function list(pagination: Pagination | undefined, tenantId: string): Promise<Activity[]> {
  return withTenant(tenantId, async (tx) => {
    let query = tx
      .select()
      .from(activityTable)
      // M21.8 — scoping por tenant en el WHERE + tenant context transaccional.
      .where(tenantScopeStrict(activityTable.tenantId, tenantId))
      .orderBy(desc(activityTable.createdAt), desc(activityTable.id))
      .$dynamic();
    if (pagination) {
      query = query.limit(pagination.limit).offset(pagination.offset);
    }
    return query;
  });
}

export async function create(values: {
  id: string;
  type: string;
  title: string;
  description: string;
  createdAt: Date;
  severity: string | null;
  /** M21.4 — tenant del evento; SIEMPRE heredado del recurso (tenant_id NOT NULL). */
  tenantId: string;
}): Promise<Activity> {
  return withTenant(values.tenantId, async (tx) => {
    const [row] = await tx
      .insert(activityTable)
      .values({ ...values, tenantId: values.tenantId })
      .returning();
    return row;
  });
}
