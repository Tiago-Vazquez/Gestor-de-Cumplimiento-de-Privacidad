import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/**
 * Roles por usuario. PK compuesta (user_sub, role) garantiza un rol único por
 * usuario; el CHECK restringe el catálogo a `admin` y `auditor` a nivel de
 * base de datos (capa de defensa en profundidad, sin depender solo de la API).
 */
export const userRolesTable = pgTable(
  "user_roles",
  {
    userSub: text("user_sub")
      .notNull()
      .references(() => usersTable.sub),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userSub, table.role] }),
    index("user_roles_user_sub_idx").on(table.userSub),
    check("user_roles_role_check", sql`${table.role} IN ('admin', 'auditor')`),
  ],
);

export const insertUserRoleSchema = createInsertSchema(userRolesTable).omit({
  createdAt: true,
});

export type UserRole = typeof userRolesTable.$inferSelect;
export type InsertUserRole = z.infer<typeof insertUserRoleSchema>;