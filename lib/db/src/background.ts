import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

type BgDatabase = ReturnType<typeof drizzle<typeof schema>>;

let bgPool: pg.Pool | undefined;
let bgClient: BgDatabase | undefined;

/**
 * M21.8 — Cliente de BD del pool BACKGROUND (`bg_role`, BYPASSRLS).
 *
 * SOLO para trusted/internal flows (scanner, scheduler, recovery). NUNCA debe
 * usarse desde rutas HTTP: `bg_role` tiene BYPASSRLS y elude el aislamiento
 * por tenant. El aislamiento HTTP usa `db` (app_role, sujeto a RLS).
 *
 * Fail-closed: lanza si `BG_DATABASE_URL` no está definida. NO hace fallback a
 * `DATABASE_URL` (un fallback silencioso conectaría el background al rol de
 * aplicación, perdiendo BYPASSRLS y rompiendo la separación de privilegios).
 *
 * Inicialización LAZY: importar este módulo no abre conexión; el error ocurre
 * en el primer uso por un flujo background, de modo que el HTTP (que no lo usa)
 * puede arrancar sin `BG_DATABASE_URL`.
 */
export function bgDb(): BgDatabase {
  if (!bgClient) {
    const url = process.env.BG_DATABASE_URL;
    if (!url) {
      throw new Error(
        "BG_DATABASE_URL is required for background jobs (bg_role/BYPASSRLS). Refusing to fall back to DATABASE_URL.",
      );
    }
    bgPool = new Pool({ connectionString: url });
    bgClient = drizzle(bgPool, { schema });
  }
  return bgClient;
}

/** Cierra el pool background (graceful shutdown). */
export async function closeBgPool(): Promise<void> {
  if (bgPool) {
    await bgPool.end();
    bgPool = undefined;
    bgClient = undefined;
  }
}
