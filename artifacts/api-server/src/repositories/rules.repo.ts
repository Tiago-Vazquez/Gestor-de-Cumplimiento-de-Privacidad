import { asc } from "drizzle-orm";
import { db, rulesTable, type Rule } from "@workspace/db";

export function list(): Promise<Rule[]> {
  return db.select().from(rulesTable).orderBy(asc(rulesTable.createdAt), asc(rulesTable.id));
}
