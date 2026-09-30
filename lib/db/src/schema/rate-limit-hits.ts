import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * M18 Fase 2 — store persistente de rate limiting para los limiters
 * sensibles (login / register / bootstrap / password-change). Clave natural
 * decidida por el `keyGenerator` de cada limiter (p. ej. `login:{ip}:{email}`);
 * el store solo ve la clave final. Ventana fija por fila: si `expires_at` ya
 * pasó, el siguiente hit reinicia la ventana (semántica fixed-window).
 */
export const rateLimitHitsTable = pgTable(
  "rate_limit_hits",
  {
    key: text("key").primaryKey(),
    hits: integer("hits").notNull().default(1),
    windowStartAt: timestamp("window_start_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("rate_limit_hits_expires_idx").on(table.expiresAt)],
);
