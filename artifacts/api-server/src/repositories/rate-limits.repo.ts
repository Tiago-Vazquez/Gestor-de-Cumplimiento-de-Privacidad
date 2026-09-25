import { pool } from "@workspace/db";

/**
 * M18 Fase 2 — persistencia del contador de rate limiting. Upsert atómico
 * fixed-window: si la fila está vencida se reinicia a 1 con ventana nueva; si
 * está viva se incrementa. Devuelve el total de hits de la ventana y cuándo
 * expira (para el header Retry-After de express-rate-limit).
 */
export async function hit(
  key: string,
  windowMs: number,
): Promise<{ totalHits: number; resetTime: Date }> {
  const windowSeconds = Math.max(1, Math.floor(windowMs / 1000));
  const result = await pool.query<{ hits: number; expires_at: Date }>(
    `INSERT INTO rate_limit_hits (key, hits, window_start_at, expires_at)
     VALUES ($1, 1, now(), now() + make_interval(secs => $2))
     ON CONFLICT (key) DO UPDATE SET
       hits = CASE WHEN rate_limit_hits.expires_at <= now()
                   THEN 1 ELSE rate_limit_hits.hits + 1 END,
       window_start_at = CASE WHEN rate_limit_hits.expires_at <= now()
                   THEN now() ELSE rate_limit_hits.window_start_at END,
       expires_at = CASE WHEN rate_limit_hits.expires_at <= now()
                   THEN now() + make_interval(secs => $2)
                   ELSE rate_limit_hits.expires_at END
     RETURNING hits, expires_at`,
    [key, windowSeconds],
  );
  const row = result.rows[0];
  if (!row) {
    // Defensivo: RETURNING siempre devuelve la fila tras INSERT/UPDATE.
    return { totalHits: 1, resetTime: new Date(Date.now() + windowMs) };
  }
  return { totalHits: Number(row.hits), resetTime: new Date(row.expires_at) };
}

/** Vuelve a cero un contador concreto (interfaz Store de express-rate-limit). */
export async function resetKey(key: string): Promise<void> {
  await pool.query("DELETE FROM rate_limit_hits WHERE key = $1", [key]);
}

/**
 * Vuelve a cero los contadores. Sin `prefix` limpia la tabla completa
 * (operación administrativa); con `prefix` solo los del limiter indicado
 * (namespace del store persistente), para no borrar los buckets ajenos.
 */
export async function resetAll(prefix?: string): Promise<void> {
  if (prefix && prefix.length > 0) {
    await pool.query("DELETE FROM rate_limit_hits WHERE starts_with(key, $1)", [
      `${prefix}:`,
    ]);
    return;
  }
  await pool.query("DELETE FROM rate_limit_hits");
}

/**
 * Decrementa sin cerrar la ventana (lo llama express-rate-limit cuando una
 * request falla antes de contar). Nunca baja de 0.
 */
export async function decrementKey(key: string): Promise<void> {
  await pool.query(
    "UPDATE rate_limit_hits SET hits = GREATEST(hits - 1, 0) WHERE key = $1",
    [key],
  );
}

/** M18 Fase 3 — purga de contadores vencidos (la invoca el sweep de sesiones). */
export async function cleanupExpired(): Promise<number> {
  const result = await pool.query<{ key: string }>(
    "DELETE FROM rate_limit_hits WHERE expires_at <= now() RETURNING key",
  );
  return result.rows.length;
}
