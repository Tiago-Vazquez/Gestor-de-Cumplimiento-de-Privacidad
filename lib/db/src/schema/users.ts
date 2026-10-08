import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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
  // --- MFA (TOTP) ---
  // Habilitado. El secreto solo es utilizable cuando este flag es true.
  mfaEnabled: boolean("mfa_enabled").notNull().default(false),
  // Secreto TOTP cifrado (AES-256-GCM vía secret-manager). Null sin MFA.
  mfaSecretEncrypted: text("mfa_secret_encrypted"),
  // Cuándo se fijó el secreto (TTL del enrolamiento pendiente).
  mfaSecretSetAt: timestamp("mfa_secret_set_at", { withTimezone: true }),
  // Cuándo se habilitó MFA.
  mfaEnabledAt: timestamp("mfa_enabled_at", { withTimezone: true }),
  // Anti-replay TOTP: último time-step verificado (monotónico).
  mfaLastVerifiedStep: integer("mfa_last_verified_step"),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  createdAt: true,
  updatedAt: true,
});

export type User = typeof usersTable.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;