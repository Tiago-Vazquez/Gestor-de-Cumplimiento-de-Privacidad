import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

// El driver node-postgres se re-exporta para que los conectores externos (p. ej.
// el scanner de fuentes PostgreSQL, FASE 7.0.1) puedan crear `pg.Client`
// independientes hacia las BD de los clientes sin declarar `pg` en cada
// consumidor. `@types/pg` ya forma parte del workspace.
export { default as pg } from "pg";

export * from "./schema";
