import { asc } from "drizzle-orm";
import { db, rulesTable, type Rule } from "@workspace/db";
import type { Pagination } from "../lib/pagination";

/** F4 (6.3B.20): paginación aplicada en SQL, orden estable. */
export function list(pagination?: Pagination): Promise<Rule[]> {
  let query = db
    .select()
    .from(rulesTable)
    .orderBy(asc(rulesTable.createdAt), asc(rulesTable.id))
    .$dynamic();
  if (pagination) {
    query = query.limit(pagination.limit).offset(pagination.offset);
  }
  return query;
}
