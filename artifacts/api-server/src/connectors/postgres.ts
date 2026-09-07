import { pg } from "@workspace/db";
import type { SourceConnectionConfig } from "../repositories/sources.repo";

/**
 * Conector PostgreSQL para fuentes externas (FASE 7.0.1).
 *
 * Abre un `pg.Client` independiente hacia la base de datos del cliente (no la
 * de la plataforma) usando la configuración descifrada de la source. Expone
 * una interfaz mínima con cierre garantizado: `close()` se invoca SIEMPRE por
 * el llamador (el servicio scanner lo asegura en un `finally`).
 *
 * El nombre de tabla se valida contra `information_schema` por el llamador y
 * se entrega entre comillas dobles con escape (`quoteIdent`) para neutralizar
 * inyección: un identificador nunca se interpola sin escapar.
 */

export interface PgConnection {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
  close(): Promise<void>;
}

export interface PgConnector {
  connect(config: SourceConnectionConfig): Promise<PgConnection>;
  listTables(conn: PgConnection, schema?: string): Promise<string[]>;
  readPage(
    conn: PgConnection,
    table: string,
    p: { limit: number; offset: number },
  ): Promise<Record<string, unknown>[]>;
}

/** Escapa un identificador SQL utilizando dobles comillas (estilo PostgreSQL). */
export function quoteIdent(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`;
}

export async function connectPg(config: SourceConnectionConfig): Promise<PgConnection> {
  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
  });
  await client.connect();

  return {
    async query<T>(text: string, params?: unknown[]): Promise<T[]> {
      const result = await client.query(text, params);
      return (result.rows as T[]) ?? [];
    },
    async close(): Promise<void> {
      await client.end();
    },
  };
}

/**
 * Lista las tablas (BASE TABLE) del schema indicado. `schema` nunca se
 * interpola: se pasa como parámetro vinculado.
 */
export async function listTables(
  conn: PgConnection,
  schema = "public",
): Promise<string[]> {
  const rows = await conn.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    [schema],
  );
  return rows.map((row) => row.table_name);
}

/**
 * Lee una página de filas (LIMIT/OFFSET) desde una tabla. El nombre de tabla
 * se escapa con `quoteIdent`; los valores van siempre parametrizados.
 */
export async function readPage(
  conn: PgConnection,
  table: string,
  p: { limit: number; offset: number },
): Promise<Record<string, unknown>[]> {
  return conn.query<Record<string, unknown>>(
    `SELECT * FROM ${quoteIdent(table)} LIMIT $1 OFFSET $2`,
    [p.limit, p.offset],
  );
}