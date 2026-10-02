import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/**
 * M30.0 — Recuperación de contraseña: SOLO el modelo de persistencia.
 *
 * Clona el diseño de seguridad de `invitations`, que ya está probado:
 *
 * - `token_hash` almacena SOLO el hash SHA-256 del token. El token en claro
 *   se genera con `randomBytes(32)`, viaja una sola vez por el seam de entrega
 *   y nunca se persiste (misma regla que `invitations.token_hash`).
 * - Índice único sobre `token_hash`: habilita el lookup por hash y garantiza
 *   que dos tokens distintos nunca colisionan.
 * - `consumed_at` marca el uso único. Igual que `invitations.accepted_at`, el
 *   consumo se hace con `IS NULL` en la misma transacción que el cambio de
 *   contraseña, de modo que dos reinicios simultáneos se serializan y el
 *   segundo falla con `already_used`.
 * - `requested_ip` guarda la IP de origen como metadato de auditoría del
 *   intento. NO es una decisión de seguridad (el token es la credencial) y no
 *   debe usarse para validar nada.
 *
 * A diferencia de `invitations`, NO hay `organization_id`: el reset es de la
 * cuenta, no de una organización.
 */
export const passwordResetTokensTable = pgTable(
  "password_reset_tokens",
  {
    id: text("id").primaryKey(),
    userSub: text("user_sub")
      .notNull()
      .references(() => usersTable.sub, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    requestedIp: text("requested_ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("password_reset_tokens_token_hash_key").on(table.tokenHash),
    // Gestión de tokens pendientes por usuario (un request nuevo invalida el anterior).
    index("password_reset_tokens_user_idx").on(table.userSub),
    check(
      "password_reset_tokens_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const insertPasswordResetTokenSchema = createInsertSchema(
  passwordResetTokensTable,
).omit({
  createdAt: true,
});

export type PasswordResetToken = typeof passwordResetTokensTable.$inferSelect;
export type InsertPasswordResetToken = z.infer<typeof insertPasswordResetTokenSchema>;