import { desc } from "drizzle-orm";
import { activityTable, db, type Activity } from "@workspace/db";
import type { Pagination } from "../lib/pagination";

/** F4 (6.3B.20): paginación aplicada en SQL (LIMIT/OFFSET), orden estable. */
export function list(pagination?: Pagination): Promise<Activity[]> {
  let query = db
    .select()
    .from(activityTable)
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
}): Promise<Activity> {
  const [row] = await db.insert(activityTable).values(values).returning();
  return row;
}
