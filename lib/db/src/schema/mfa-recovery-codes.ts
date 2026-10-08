import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/**
 * MFA — códigos de recuperación (single-use).
 *
 * Clona el diseño de `password_reset_tokens`:
 * - `code_hash` almacena SOLO el hash SHA-256 del código. El código en claro se
 *   genera con `randomBytes`, se entrega UNA vez al usuario y nunca se persiste.
 * - Índice único sobre `code_hash`: lookup por hash + sin colisiones.
 * - `used_at` marca el uso único: consumo transaccional con `FOR UPDATE` +
 *   `IS NULL` (el segundo consumidor concurrente falla con `already_used`).
 * - `user_sub` con `ON DELETE CASCADE`: borrar el usuario borra sus códigos.
 */
export const mfaRecoveryCodesTable = pgTable(
  "mfa_recovery_codes",
  {
    id: text("id").primaryKey(),
    userSub: text("user_sub")
      .notNull()
      .references(() => usersTable.sub, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("mfa_recovery_codes_code_hash_key").on(table.codeHash),
    index("mfa_recovery_codes_user_idx").on(table.userSub),
  ],
);

export const insertMfaRecoveryCodeSchema = createInsertSchema(
  mfaRecoveryCodesTable,
).omit({
  createdAt: true,
});

export type MfaRecoveryCode = typeof mfaRecoveryCodesTable.$inferSelect;
export type InsertMfaRecoveryCode = z.infer<typeof insertMfaRecoveryCodeSchema>;
