import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Usuarios de la aplicación.
 *
 * `sub` es el identificador estable (PK), provisto por el futuro proveedor de
 * identidad (JWT/OIDC) y único para cada persona. `email` es único (segundo
 * identificador natural para sincronizar roles/altas). `name` es opcional.
 */
export const usersTable = pgTable("users", {
  sub: text("sub").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  createdAt: true,
  updatedAt: true,
});

export type User = typeof usersTable.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;