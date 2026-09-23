import { desc } from "drizzle-orm";
import { activityTable, db, type Activity } from "@workspace/db";
import type { Pagination } from "../lib/pagination";
import { tenantScopeStrict } from "./tenant";

/** F4 (6.3B.20): paginación aplicada en SQL (LIMIT/OFFSET), orden estable. */
export function list(pagination: Pagination | undefined, tenantId: string): Promise<Activity[]> {
  let query = db
    .select()
    .from(activityTable)
    // M21.7 — scoping ESTRICTO obligatorio por tenant (fail-closed en el contrato).
    .where(tenantScopeStrict(activityTable.tenantId, tenantId))
    .orderBy(desc(activityTable.createdAt), desc(activityTable.id))
    .$dynamic();
  if (pagination) {
    query = query.limit(pagination.limit).offset(pagination.offset);
  }
  return query;
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
  const [row] = await db
    .insert(activityTable)
    .values({ ...values, tenantId: values.tenantId })
    .returning();
  return row;
}
