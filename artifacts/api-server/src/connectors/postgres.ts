/**
 * Conector PostgreSQL para fuentes externas (FASE 7.0.1; refactor M23.1).
 *
 * Abre un `pg.Client` independiente hacia la base de datos del cliente (no la
 * de la plataforma) usando la configuración descifrada de la source. Expone
 * una interfaz mínima con cierre garantizado: `close()` se invoca SIEMPRE por
 * el llamador (el servicio scanner lo asegura en un `finally`).
 *
 * M23.1:
 * - Implementa `SourceConnector` (types.ts) y se registra en `registry.ts`;
 *   scanner/masking ya NO importan este módulo directamente.
 * - Timeouts reales (Fase 5): `connectionTimeoutMillis` (connect),
 *   `statement_timeout` (server-side) y `query_timeout` (client-side) — un
 *   scan bloqueado NO espera al `SCAN_RUNNING_TTL_MS` para resolver.
 * - Errores clasificados en `ConnectorError` (unreachable / auth_failed /
 *   timeout / query_failed) con mensajes fijos: nunca interpolan host,
 *   DSN ni password (nada de secretos en logs o errores persistidos).
 *
 * El nombre de tabla se valida contra `information_schema` por el llamador y
 * se entrega entre comillas dobles con escape (`quoteIdent`) para neutralizar
 * inyección: un identificador nunca se interpola sin escapar.
 *
 * DEUDA DOCUMENTADA (M23.1, fuera de alcance): `readPage` pagina con
 * LIMIT/OFFSET SIN ORDER BY estable (comportamiento histórico preservado).
 */
import { pg } from "@workspace/db";
import {
  ConnectorError,
  resolveConnectorTimeouts,
  type ConnectionConfig,
  type ConnectorCapabilities,
  type SourceConnection,
  type SourceConnector,
  type TableRef,
} from "./types";

/** Handle de conexión específico de PostgreSQL (query interno + cierre). */
export interface PgConnection extends SourceConnection {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Namespace default resuelto en connect (config.schema ?? "public"). */
  defaultNamespace?: string;
}

/** Capacidades del motor PostgreSQL. */
export const PG_CAPABILITIES: ConnectorCapabilities = {
  relational: true,
  namespaces: true,
  offsetPagination: true,
  enumeratesTables: true,
};

/** Escapa un identificador SQL utilizando dobles comillas (estilo PostgreSQL). */
export function quoteIdent(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`;
}

/** Extrae el código de un error del driver (SQLSTATE o errno de red). */
function driverCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * Clasifica un error de connect en `ConnectorError` sin propagar nunca el
 * mensaje original del driver (puede contener host/DSN): message fijo.
 */
function classifyConnectError(err: unknown): ConnectorError {
  const code = driverCode(err);
  const message = err instanceof Error ? err.message : "";
  if (code === "28P01" || code === "28000" || code === "28006") {
    return new ConnectorError("auth_failed", "Source authentication failed", { cause: err });
  }
  if (code === "ETIMEDOUT" || /timeout|timed out/i.test(message)) {
    return new ConnectorError("timeout", "Connection to source timed out", { cause: err });
  }
  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "EAI_AGAIN" ||
    code === "ECONNRESET"
  ) {
    return new ConnectorError("unreachable", "Source database is unreachable", { cause: err });
  }
  // Resto de fallos de handshake (p.ej. protocolo) → inalcanzable.
  return new ConnectorError("unreachable", "Could not connect to source database", { cause: err });
}


/**
 * Clasifica un error de query: timeout primero (57014 = query_canceled por
 * statement_timeout), auth rara post-conectado, resto → query_failed.
 */
function classifyQueryError(err: unknown): ConnectorError {
  const code = driverCode(err);
  const message = err instanceof Error ? err.message : "";
  if (code === "57014" || /statement timeout|query timeout|timeout/i.test(message)) {
    return new ConnectorError("timeout", "Query against source timed out", { cause: err });
  }
  if (code === "28P01" || code === "28000") {
    return new ConnectorError("auth_failed", "Source authentication failed", { cause: err });
  }
  return new ConnectorError("query_failed", "Query against source failed", { cause: err });
}

/**
 * Establece `statement_timeout` en la sesión (server-side). Best-effort: si el
 * rol remoto no permite SET, el `query_timeout` del cliente sigue operativo.
 */
async function applyStatementTimeout(client: pg.Client, timeoutMs: number): Promise<void> {
  try {
    await client.query(`SET statement_timeout = ${Math.floor(timeoutMs)}`);
  } catch {
    // No fatal: defensa en profundidad con query_timeout client-side.
  }
}

/**
 * Abre la conexión con timeouts reales (Fase 5). `config` debe ser de kind
 * `postgresql`: una config MySQL u otro kind se rechaza con `unsupported`
 * ANTES de tocar la red (una config inválida nunca llega a conectarse vía PG).
 */
export async function connectPg(config: ConnectionConfig): Promise<PgConnection> {
  if (config.kind !== "postgresql") {
    throw new ConnectorError("unsupported", "Configuration kind mismatch for PostgreSQL connector");
  }
  const timeouts = resolveConnectorTimeouts();
  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: timeouts.connectTimeoutMs,
    query_timeout: timeouts.queryTimeoutMs,
  });

  try {
    await client.connect();
  } catch (err) {
    try {
      await client.end();
    } catch {
      /* best-effort: liberar socket parcial */
    }
    throw classifyConnectError(err);
  }

  await applyStatementTimeout(client, timeouts.queryTimeoutMs);

  return {
    async query<T>(text: string, params?: unknown[]): Promise<T[]> {
      try {
        const result = await client.query(text, params);
        return (result.rows as T[]) ?? [];
      } catch (err) {
        throw classifyQueryError(err);
      }
    },
    async close(): Promise<void> {
      await client.end();
    },
    defaultNamespace: config.schema && config.schema.length > 0 ? config.schema : "public",
  };
}

/**
 * Lista las tablas (BASE TABLE) del schema indicado. `schema` nunca se
 * interpola: se pasa como parámetro vinculado.
 */
export async function listTables(
  conn: SourceConnection,
  schema = "public",
): Promise<string[]> {
  const pgConn = conn as PgConnection;
  const rows = await pgConn.query<{ table_name: string }>(
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
 * DEUDA: sin ORDER BY estable — preservado tal cual de la FASE 7.0.1 (M23.1).
 */
export async function readPage(
  conn: SourceConnection,
  table: string,
  p: { limit: number; offset: number },
): Promise<Record<string, unknown>[]> {
  const pgConn = conn as PgConnection;
  return pgConn.query<Record<string, unknown>>(
    `SELECT * FROM ${quoteIdent(table)} LIMIT $1 OFFSET $2`,
    [p.limit, p.offset],
  );
}

/**
 * Conector PostgreSQL registrado en el registry (M23.1). El namespace default
 * lo aporta el llamador (scanner: config.schema ?? "public"); aquí se listan
 * las tablas de ese namespace y se devuelven como `TableRef`.
 */
export const postgresConnector: SourceConnector = {
  kind: "postgresql",
  capabilities: PG_CAPABILITIES,
  async connect(config: ConnectionConfig): Promise<SourceConnection> {
    return connectPg(config);
  },
  async listTables(conn: SourceConnection, opts?: { namespace?: string }): Promise<TableRef[]> {
    const pgConn = conn as PgConnection;
    const schema = opts?.namespace ?? pgConn.defaultNamespace ?? "public";
    const names = await listTables(conn, schema);
    return names.map((name) => ({ name, namespace: schema }));
  },
  async readPage(conn, table, p) {
    return readPage(conn, table.name, p);
  },
};
