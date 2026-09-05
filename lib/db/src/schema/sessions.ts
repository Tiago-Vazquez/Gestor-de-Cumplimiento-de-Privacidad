import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/**
 * Sesiones server-side (allowlist por jti). Cada JWT emitido registra una fila
 * con su `jti` (PK). `requireAuth` exige fila activa (no revocada y no
 * expirada) para tokens con `jti`. `ON DELETE CASCADE` garantiza que eliminar
 * un usuario invalida sus sesiones al instante. La expiración autoritativa
 * sigue siendo la del JWT (`exp`); `expires_at` es redundancia defensiva.
 */
export const sessionsTable = pgTable(
  "sessions",
  {
    jti: text("jti").primaryKey(),
    userSub: text("user_sub")
      .notNull()
      .references(() => usersTable.sub, { onDelete: "cascade" }),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("sessions_user_sub_idx").on(table.userSub),
    index("sessions_active_user_idx").on(table.userSub).where(sql`revoked_at IS NULL`),
    check("sessions_expiry_check", sql`${table.expiresAt} > ${table.issuedAt}`),
  ],
);

export const insertSessionSchema = createInsertSchema(sessionsTable).omit({
  issuedAt: true,
});

export type Session = typeof sessionsTable.$inferSelect;
export type InsertSession = z.infer<typeof insertSessionSchema>;