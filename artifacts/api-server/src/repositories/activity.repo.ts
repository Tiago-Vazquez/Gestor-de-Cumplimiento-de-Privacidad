import { desc } from "drizzle-orm";
import { activityTable, db, type Activity } from "@workspace/db";
import type { Pagination } from "../lib/pagination";
import { tenantScope } from "./tenant";

/** F4 (6.3B.20): paginación aplicada en SQL (LIMIT/OFFSET), orden estable. */
export function list(pagination?: Pagination, tenantId?: string): Promise<Activity[]> {
  let query = db
    .select()
    .from(activityTable)
    // M21.3 — scoping en el WHERE (D2: tenant activo o legacy NULL).
    .where(tenantId ? tenantScope(activityTable.tenantId, tenantId) : undefined)
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
  /** M21.3 — tenant del evento; los llamadores lo heredan del recurso. */
  tenantId?: string | null;
}): Promise<Activity> {
  const [row] = await db
    .insert(activityTable)
    .values({ ...values, tenantId: values.tenantId ?? null })
    .returning();
  return row;
}
