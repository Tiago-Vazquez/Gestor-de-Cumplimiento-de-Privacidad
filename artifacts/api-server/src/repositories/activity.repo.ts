import { desc } from "drizzle-orm";
import { activityTable, db, type Activity } from "@workspace/db";

export function list(): Promise<Activity[]> {
  return db
    .select()
    .from(activityTable)
    .orderBy(desc(activityTable.createdAt), desc(activityTable.id));
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
