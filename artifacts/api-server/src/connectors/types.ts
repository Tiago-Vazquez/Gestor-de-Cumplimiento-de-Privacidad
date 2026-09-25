/**
 * M23.1 — Tipos compartidos de la capa de conectores de fuentes externas.
 *
 * Diseño preparado para M23.2+ (MongoDB/Snowflake/BigQuery):
 * - `ConnectionConfig` es una unión discriminada por `kind`: cada motor
 *   declara su forma de configuración y un conector NUNCA acepta una
 *   configuración de otro motor (guardia en runtime dentro de `connect`).
 * - `TableRef` NO está acoplado a `schema.table.column`: `name` es el
 *   identificador canónico de la tabla/colección y `namespace` es opcional
 *   (schema en PostgreSQL; database en MySQL/MongoDB). La composición del
 *   `location` de findings vive en el scanner, no aquí.
 *
 * Formato `location` (contrato histórico a preservar):
 * - M23.1 PostgreSQL: `tabla.column` p. ej. `users.contact` — los findings
 *   existentes y el guard de masking NO cambian por este refactor.
 * - Extensión M23.2 (MongoDB, fuera de alcance): location `db.coleccion.campo`
 *   (3 segmentos) resoluble desde `TableRef { name, namespace }`.
 *
 * Módulo PURO (type-level + helpers sin I/O): sin imports de drivers ni de
 * `@workspace/db`, para que rutas/repos lo consuman sin cargar motores.
 */

/** Kinds de fuente reconocidos por la plataforma (OpenAPI: DataSource.kind). */
export type SourceKind = "postgresql" | "mysql" | "mongodb" | "snowflake" | "bigquery";

/** Campos comunes a los motores relacionales soportados (M23.1). */
interface SqlConnectionConfig {
  /** Database host (hostname o IP). */
  host: string;
  /** Puerto (1-65535). */
  port: number;
  /** Nombre de la base de datos. */
  database: string;
  /** Usuario de autenticación. */
  user: string;
  /** Contraseña (write-only: se almacena cifrada con AES-256-GCM). */
  password: string;
  /** Schema opcional (PG: schema; MySQL: schema≈database, default = database). */
  schema?: string;
}

/** Configuración de conexión de una fuente PostgreSQL. */
export interface PostgresConnectionConfig extends SqlConnectionConfig {
  kind: "postgresql";
}

/** Configuración de conexión de una fuente MySQL. */
export interface MysqlConnectionConfig extends SqlConnectionConfig {
  kind: "mysql";
}

/**
 * Unión discriminada por `kind`. En M23.2 se agrega, p. ej.:
 *   `MongoConnectionConfig { kind: "mongodb"; ... }` — la forma exacta la
 *   define cada conector; el scanner solo exige poder discriminar por `kind`.
 */
export type ConnectionConfig = PostgresConnectionConfig | MysqlConnectionConfig;

/**
 * Kinds con conector registrado en M23.1 (subconjunto de `SourceKind`).
 * `mongodb | snowflake | bigquery` → `source_not_scannable` hasta M23.2.
 */
export type SupportedSourceKind = ConnectionConfig["kind"];

/** Opciones de timeout aplicables a connect/query por conector. */
export interface ConnectorTimeoutOptions {
  /** Timeout de conexión (TCP + handshake). Default 10s. */
  connectTimeoutMs: number;
  /** Timeout de una statement/query. Default 30s. */
  queryTimeoutMs: number;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

function readTimeout(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 100 || value > 300_000) return fallback;
  return Math.floor(value);
}

/**
 * Timeouts efectivos. Las envs `SOURCE_CONNECT_TIMEOUT_MS` y
 * `SOURCE_QUERY_TIMEOUT_MS` permiten acortarlos (tests/entornos hostiles);
 * valores inválidos o fuera de rango caen al default (fail-safe).
 * Conectores deben usar estos timeouts para NO esperar al `SCAN_RUNNING_TTL_MS`.
 */
export function resolveConnectorTimeouts(
  env: NodeJS.ProcessEnv = process.env,
): ConnectorTimeoutOptions {
  return {
    connectTimeoutMs: readTimeout(env.SOURCE_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS),
    queryTimeoutMs: readTimeout(env.SOURCE_QUERY_TIMEOUT_MS, DEFAULT_QUERY_TIMEOUT_MS),
  };
}

/**
 * Referencia canónica a una tabla/colección dentro de una fuente.
 *
 * M23.1 (relacional): `name` = nombre de tabla sin calificar; `namespace` =
 * schema (PG) o database (MySQL) del que proviene el listado. El scanner
 * compone el `location` de findings como `name.column` para preservar el
 * contrato histórico (`users.contact`).
 *
 * M23.2 (MongoDB, diseño previsto, fuera de alcance): `namespace` = database,
 * `name` = colección; location `namespace.name.campo`. Esta abstracción NO
 * impone `schema.table.column`: la composición queda en el consumidor.
 */
export interface TableRef {
  /** Nombre canónico de la tabla/colección (sin namespace). */
  name: string;
  /** Namespace opcional: schema (PG), database (MySQL/Mongo). */
  namespace?: string;
}

/**
 * Handle de conexión abierto hacia una fuente externa. Los consumidores SOLO
 * usan `close()` (garantizado en `finally` por scanner y masking). No expone
 * `query`: cada modelo internamente lo necesita, pero la interfaz pública no
 * obliga a motores no relacionales a "fingir" SQL.
 */
export interface SourceConnection {
  /** Cierra la conexión. Los llamadores la invocan SIEMPRE en `finally`. */
  close(): Promise<void>;
}

/** Capacidades declaradas por un conector (información para consumidores/tests). */
export interface ConnectorCapabilities {
  /** Motor relacional con SQL parametrizado sobre tablas/columnas. */
  relational: boolean;
  /** Soporta namespaces (schema/database) en `TableRef`. */
  namespaces: boolean;
  /** Soporta paginación offset/limit sobre filas. */
  offsetPagination: boolean;
  /** Soporta listar el catálogo de tablas/colecciones. */
  enumeratesTables: boolean;
}

/** Códigos de error de conector — clasificación conceptual (Fase 5). */
export type ConnectorErrorCode =
  /** Host inalcanzable / refused / DNS. */
  | "unreachable"
  /** Credenciales o autorización rechazadas (SQLSTATE 28xxx / ER_ACCESS_DENIED). */
  | "auth_failed"
  /** Timeout de conexión o de statement/query. */
  | "timeout"
  /** La query falló (sintaxis, relación inexistente, etc.). */
  | "query_failed"
  /** Kind sin conector registrado o config incompatible con el conector. */
  | "unsupported";

/**
 * Error de conector con causa clasificada. El `message` es SIEMPRE texto
 * fijo seguro (nunca concatena host, DSN ni password): el detalle del driver
 * vive en `cause` y no se persiste en logs ni en errores de scan.
 */
export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  override readonly cause?: unknown;

  constructor(code: ConnectorErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.cause = options?.cause;
  }
}

/**
 * Contrato de un conector de fuente externa. Genérico para M23.2: no asume
 * SQL. `listTables`/`readPage` son las operaciones mínimas que scanner y
 * masking necesitan; un conector documental puede implementar `readPage` con
 * cursores internos sin exponerlos aquí.
 */
export interface SourceConnector {
  /** Kind que este conector atiende (igual al discriminador de config). */
  readonly kind: SupportedSourceKind;
  /** Capacidades declaradas del motor. */
  readonly capabilities: ConnectorCapabilities;
  /** Abre una conexión. DEBE rechazar configs cuyo `kind` no coincida. */
  connect(config: ConnectionConfig): Promise<SourceConnection>;
  /** Lista las tablas/colecciones del namespace dado (o el default del config). */
  listTables(
    conn: SourceConnection,
    opts?: { namespace?: string },
  ): Promise<TableRef[]>;
  /** Lee una página de filas desde `table` con limit/offset. */
  readPage(
    conn: SourceConnection,
    table: TableRef,
    p: { limit: number; offset: number },
  ): Promise<Record<string, unknown>[]>;
}


/**
 * Valida y normaliza una configuración descifrada contra el kind de la fuente
 * (defensa server-side además de OpenAPI). Devuelve `null` (fail-closed) si:
 * - el kind no tiene conector en M23.1 (mongodb/snowflake/bigquery);
 * - el JSON guardado declara un `kind` distinto al de la fuente (p. ej. la
 *   fuente cambió de motor sin re-configurar) — nunca se conectará con un
 *   motor distinto al declarado;
 * - falta un campo obligatorio o un valor está fuera de rango (mismos límites
 *   que el contrato OpenAPI: host 1..253, port entero 1..65535, database/
 *   user/password no vacíos con sus máximos, schema ≤ 128).
 * Solo devuelve los campos conocidos (los extras se descartan).
 */
export function normalizeConnectionConfig(
  sourceKind: string,
  raw: unknown,
): ConnectionConfig | null {
  if (sourceKind !== "postgresql" && sourceKind !== "mysql") return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  if (record.kind !== undefined && record.kind !== sourceKind) return null;

  const { host, port, database, user, password, schema } = record;
  if (typeof host !== "string" || host.length < 1 || host.length > 253) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof database !== "string" || database.length < 1 || database.length > 128) return null;
  if (typeof user !== "string" || user.length < 1 || user.length > 128) return null;
  if (typeof password !== "string" || password.length < 1 || password.length > 256) return null;
  if (schema !== undefined && schema !== null && (typeof schema !== "string" || schema.length > 128)) {
    return null;
  }

  const base = {
    host,
    port,
    database,
    user,
    password,
    ...(typeof schema === "string" && schema.length > 0 ? { schema } : {}),
  };
  return sourceKind === "postgresql"
    ? { kind: "postgresql", ...base }
    : { kind: "mysql", ...base };
}
