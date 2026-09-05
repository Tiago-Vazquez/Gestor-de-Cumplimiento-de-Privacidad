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
  // Hash de contraseña (scrypt). Null para usuarios sin contraseña local
  // (ej. bootstrap-admin o usuarios OIDC futuros).
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Último login exitoso. Null si nunca ha iniciado sesión.
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  createdAt: true,
  updatedAt: true,
});

export type User = typeof usersTable.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;