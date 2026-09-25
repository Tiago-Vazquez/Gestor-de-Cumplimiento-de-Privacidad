/**
 * Conector MySQL para fuentes externas (nuevo en M23.1).
 *
 * Mismos principios que PostgreSQL:
 * - Implementa `SourceConnector` y se registra en `registry.ts` — scanner y
 *   masking lo resuelven por factory, nunca importan este módulo.
 * - Timeouts reales (Fase 5): `connectTimeout` (driver) + watchdog de query
 *   que DESTRUYE la conexión al expirar (no esperar al `SCAN_RUNNING_TTL_MS`).
 * - Errores clasificados en `ConnectorError` (unreachable / auth_failed /
 *   timeout / query_failed) con mensajes fijos (sin host/DSN/password).
 * - Queries SIEMPRE parametrizadas; identificadores SOLO vía `quoteIdent`
 *   (backticks con escape) — nunca se interpola un nombre sin escapar.
 *
 * DEUDA DOCUMENTADA (M23.1, fuera de alcance): paginación LIMIT/OFFSET sin
 * ORDER BY estable (paridad con el comportamiento histórico de PostgreSQL).
 */
import { createConnection, type Connection as MysqlRawConnection } from "mysql2/promise";
import {
  ConnectorError,
  resolveConnectorTimeouts,
  type ConnectionConfig,
  type ConnectorCapabilities,
  type SourceConnection,
  type SourceConnector,
  type TableRef,
} from "./types";

/** Handle de conexión específico de MySQL (query interno + cierre). */
export interface MysqlConnection extends SourceConnection {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Namespace default resuelto en connect (config.schema ?? config.database). */
  defaultNamespace?: string;
}

/** Capacidades del motor MySQL. */
export const MYSQL_CAPABILITIES: ConnectorCapabilities = {
  relational: true,
  namespaces: true,
  offsetPagination: true,
  enumeratesTables: true,
};

/** Escapa un identificador SQL utilizando backticks (estilo MySQL). */
export function quoteIdent(ident: string): string {
  return `\`${ident.replaceAll("`", "``")}\``;
}

/** Extrae el código de un error del driver (errno/ código de red). */
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
  if (code === "ER_ACCESS_DENIED_ERROR" || code === "ER_DBACCESS_DENIED_ERROR") {
    return new ConnectorError("auth_failed", "Source authentication failed", { cause: err });
  }
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || /timeout|timed out/i.test(message)) {
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
  return new ConnectorError("unreachable", "Could not connect to source database", { cause: err });
}


/**
 * Clasifica un error de query en `ConnectorError` (message fijo, sin DSN).
 */
function classifyQueryError(err: unknown): ConnectorError {
  const code = driverCode(err);
  const message = err instanceof Error ? err.message : "";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || /timeout|timed out/i.test(message)) {
    return new ConnectorError("timeout", "Query against source timed out", { cause: err });
  }
  if (code === "ER_ACCESS_DENIED_ERROR" || code === "ER_DBACCESS_DENIED_ERROR") {
    return new ConnectorError("auth_failed", "Source authentication failed", { cause: err });
  }
  return new ConnectorError("query_failed", "Query against source failed", { cause: err });
}

/**
 * Watchdog de query (Fase 5): al expirar destruye la conexión (el handle es
 * por-scan y el scanner la cierra igual en `finally`) y rechaza con
 * `ConnectorError("timeout")` — nunca esperamos al reaper del scanner.
 */
async function withQueryTimeout<T>(
  raw: MysqlRawConnection,
  work: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          try {
            raw.destroy();
          } catch {
            /* ya inutilizable */
          }
          reject(new ConnectorError("timeout", "Query against source timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Abre la conexión con timeouts reales (Fase 5). `config` debe ser de kind
 * `mysql`: una config PostgreSQL u otro kind se rechaza con `unsupported`
 * ANTES de tocar la red.
 */
export async function connectMysql(config: ConnectionConfig): Promise<MysqlConnection> {
  if (config.kind !== "mysql") {
    throw new ConnectorError("unsupported", "Configuration kind mismatch for MySQL connector");
  }
  const timeouts = resolveConnectorTimeouts();
  let raw: MysqlRawConnection;
  try {
    raw = await createConnection({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      connectTimeout: timeouts.connectTimeoutMs,
    });
  } catch (err) {
    throw classifyConnectError(err);
  }

  return {
    async query<T>(text: string, params?: unknown[]): Promise<T[]> {
      try {
        const [rows] = await withQueryTimeout(raw, raw.query(text, params), timeouts.queryTimeoutMs);
        return (rows as T[]) ?? [];
      } catch (err) {
        throw classifyQueryError(err);
      }
    },
    async close(): Promise<void> {
      try {
        await raw.end();
      } catch {
        // Cierre best-effort: si el socket murió, no hay nada que limpiar.
      }
    },
    defaultNamespace:
      config.schema && config.schema.length > 0 ? config.schema : config.database,
  };
}

/**
 * Lista las tablas (BASE TABLE) del schema indicado. El schema NUNCA se
 * interpola: va como parámetro vinculado (`?`).
 */
export async function listTables(
  conn: SourceConnection,
  schema: string,
): Promise<string[]> {
  const myConn = conn as MysqlConnection;
  // MySQL 8 expone las columnas de `information_schema` en MAYÚSCULAS
  // (`TABLE_NAME`); el alias con backticks preserva el nombre en minúsculas y
  // el fallback cubre servidores/versiones que devuelvan el nombre original.
  const rows = await myConn.query<{ table_name?: string; TABLE_NAME?: string }>(
    `SELECT TABLE_NAME AS \`table_name\`
       FROM information_schema.tables
      WHERE table_schema = ?
        AND table_type = 'BASE TABLE'
      ORDER BY TABLE_NAME`,
    [schema],
  );
  return rows.map((row) => row.table_name ?? row.TABLE_NAME ?? "");
}

/**
 * Lee una página de filas (LIMIT/OFFSET) desde una tabla. El nombre se escapa
 * con `quoteIdent` (backticks); limit/offset van parametrizados.
 * DEUDA: sin ORDER BY estable — paridad con PostgreSQL en M23.1.
 */
export async function readPage(
  conn: SourceConnection,
  table: string,
  p: { limit: number; offset: number },
): Promise<Record<string, unknown>[]> {
  const myConn = conn as MysqlConnection;
  return myConn.query<Record<string, unknown>>(
    `SELECT * FROM ${quoteIdent(table)} LIMIT ? OFFSET ?`,
    [p.limit, p.offset],
  );
}

/**
 * Conector MySQL registrado en el registry (M23.1). El namespace default lo
 * aporta el llamador (scanner: config.schema ?? config.database vía la config
 * de la fuente); aquí se listan las tablas de ese namespace como `TableRef`.
 */
export const mysqlConnector: SourceConnector = {
  kind: "mysql",
  capabilities: MYSQL_CAPABILITIES,
  async connect(config: ConnectionConfig): Promise<SourceConnection> {
    return connectMysql(config);
  },
  async listTables(conn: SourceConnection, opts?: { namespace?: string }): Promise<TableRef[]> {
    const myConn = conn as MysqlConnection;
    const schema = opts?.namespace ?? myConn.defaultNamespace;
    if (!schema) {
      // Fail-closed: nunca listar "todas" las tablas de todos los databases.
      throw new ConnectorError("query_failed", "Namespace is required for MySQL table listing");
    }
    const names = await listTables(conn, schema);
    return names.map((name) => ({ name, namespace: schema }));
  },
  async readPage(conn, table, p) {
    return readPage(conn, table.name, p);
  },
};
