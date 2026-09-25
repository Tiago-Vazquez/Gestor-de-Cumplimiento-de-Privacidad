/**
 * M23.1 — Tests unitarios de la capa de conectores (registry, contrato de
 * tipos, validación de config y timeouts).
 *
 * Sin red ni motores reales: `@workspace/db` se sustituye por stubs (igual que
 * en el resto de la suite) y solo se ejercitan rutas que NO abren sockets.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn(), end: vi.fn() },
  pg: { Client: class MockClient {} },
}));

import {
  ConnectorError,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_QUERY_TIMEOUT_MS,
  normalizeConnectionConfig,
  resolveConnectorTimeouts,
  type ConnectionConfig,
} from "../connectors/types";
import { getConnector, isSupportedKind, supportedKinds } from "../connectors/registry";
import { quoteIdent as quotePgIdent } from "../connectors/postgres";
import { quoteIdent as quoteMysqlIdent } from "../connectors/mysql";

const pgConfig: ConnectionConfig = {
  kind: "postgresql",
  host: "db.internal",
  port: 5432,
  database: "app",
  user: "scanner",
  password: "super-secret-password",
  schema: "public",
};

const mysqlConfig: ConnectionConfig = {
  kind: "mysql",
  host: "mysql.internal",
  port: 3306,
  database: "crm",
  user: "scanner",
  password: "super-secret-password",
};

describe("M23.1 registry — resolución kind → conector", () => {
  it("resuelve los conectores soportados con su kind declarado", () => {
    expect(getConnector("postgresql").kind).toBe("postgresql");
    expect(getConnector("mysql").kind).toBe("mysql");
  });

  it("declara capacidades completas para motores SQL", () => {
    for (const kind of ["postgresql", "mysql"] as const) {
      expect(getConnector(kind).capabilities).toEqual({
        relational: true,
        namespaces: true,
        offsetPagination: true,
        enumeratesTables: true,
      });
    }
  });

  it("isSupportedKind distingue soportados de declarados-sin-conector", () => {
    expect(isSupportedKind("postgresql")).toBe(true);
    expect(isSupportedKind("mysql")).toBe(true);
    // Declarados en el contrato pero sin conector hasta M23.2.
    expect(isSupportedKind("mongodb")).toBe(false);
    expect(isSupportedKind("snowflake")).toBe(false);
    expect(isSupportedKind("bigquery")).toBe(false);
  });

  it("getConnector lanza ConnectorError(unsupported) para kinds desconocidos", () => {
    let thrown: unknown;
    try {
      getConnector("mongodb");
      expect.unreachable();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConnectorError);
    expect((thrown as ConnectorError).code).toBe("unsupported");
  });

  it("expone el catálogo de kinds soportados", () => {
    expect(supportedKinds().sort()).toEqual(["mysql", "postgresql"]);
  });
});

describe("M23.1 config — validación server-side (normalizeConnectionConfig)", () => {
  it("acepta configs válidas y preserva el discriminador", () => {
    expect(normalizeConnectionConfig("postgresql", { ...pgConfig })).toEqual(pgConfig);
    expect(normalizeConnectionConfig("mysql", { ...mysqlConfig })).toEqual(mysqlConfig);
  });

  it("acepta configs legacy sin `kind` (se adopta el de la fuente)", () => {
    const legacy = { ...pgConfig } as Record<string, unknown>;
    delete legacy.kind;
    expect(normalizeConnectionConfig("postgresql", legacy)).toEqual(pgConfig);
  });

  it("rechaza kind sin conector (mongodb/snowflake/bigquery)", () => {
    expect(normalizeConnectionConfig("mongodb", { ...mysqlConfig })).toBeNull();
    expect(normalizeConnectionConfig("snowflake", { ...pgConfig })).toBeNull();
  });

  it("rechaza kind mismatch entre config y fuente (PG ↔ MySQL)", () => {
    expect(normalizeConnectionConfig("postgresql", { ...mysqlConfig })).toBeNull();
    expect(normalizeConnectionConfig("mysql", { ...pgConfig })).toBeNull();
  });

  it("rechaza campos faltantes o fuera de rango", () => {
    expect(normalizeConnectionConfig("postgresql", { ...pgConfig, host: "" })).toBeNull();
    expect(normalizeConnectionConfig("postgresql", { ...pgConfig, port: 0 })).toBeNull();
    expect(normalizeConnectionConfig("postgresql", { ...pgConfig, port: 65536 })).toBeNull();
    expect(normalizeConnectionConfig("postgresql", { ...pgConfig, port: "5432" })).toBeNull();
    expect(normalizeConnectionConfig("postgresql", { ...pgConfig, database: "" })).toBeNull();
    expect(normalizeConnectionConfig("postgresql", { ...pgConfig, user: "" })).toBeNull();
    expect(normalizeConnectionConfig("postgresql", { ...pgConfig, password: "" })).toBeNull();
    expect(normalizeConnectionConfig("postgresql", { ...pgConfig, host: "h".repeat(254) })).toBeNull();
    expect(normalizeConnectionConfig("postgresql", { ...pgConfig, schema: "s".repeat(129) })).toBeNull();
  });

  it("rechaza valores no-objeto (JSON corrupto)", () => {
    expect(normalizeConnectionConfig("postgresql", null)).toBeNull();
    expect(normalizeConnectionConfig("postgresql", "dsn://user:pass@host/db")).toBeNull();
    expect(normalizeConnectionConfig("postgresql", [pgConfig])).toBeNull();
  });

  it("descarta campos desconocidos (no se propaga basura al ciphertext)", () => {
    const result = normalizeConnectionConfig("postgresql", { ...pgConfig, extra: "x" });
    expect(result).toEqual(pgConfig);
    expect(result && "extra" in result).toBe(false);
  });
});

describe("M23.1 timeouts — opciones por conector (Fase 5)", () => {
  const KEY_CONNECT = "SOURCE_CONNECT_TIMEOUT_MS";
  const KEY_QUERY = "SOURCE_QUERY_TIMEOUT_MS";
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    original[KEY_CONNECT] = process.env[KEY_CONNECT];
    original[KEY_QUERY] = process.env[KEY_QUERY];
    delete process.env[KEY_CONNECT];
    delete process.env[KEY_QUERY];
  });

  afterEach(() => {
    for (const key of [KEY_CONNECT, KEY_QUERY]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it("usa defaults seguros (10s connect / 30s query)", () => {
    expect(resolveConnectorTimeouts()).toEqual({
      connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      queryTimeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
    });
  });

  it("permite acortar los timeouts por env (tests/entornos hostiles)", () => {
    process.env[KEY_CONNECT] = "1500";
    process.env[KEY_QUERY] = "2000";
    expect(resolveConnectorTimeouts()).toEqual({
      connectTimeoutMs: 1500,
      queryTimeoutMs: 2000,
    });
  });

  it("ignora valores inválidos o fuera de rango (fail-safe al default)", () => {
    process.env[KEY_CONNECT] = "0";
    process.env[KEY_QUERY] = "no-numero";
    expect(resolveConnectorTimeouts()).toEqual({
      connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      queryTimeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
    });
  });
});

describe("M23.1 SQL — quoting de identificadores", () => {
  it("PostgreSQL escapa comillas dobles", () => {
    expect(quotePgIdent("users")).toBe('"users"');
    expect(quotePgIdent('we"ird')).toBe('"we""ird"');
  });

  it("MySQL escapa backticks", () => {
    expect(quoteMysqlIdent("users")).toBe("`users`");
    expect(quoteMysqlIdent("we`ird")).toBe("`we``ird`");
  });
});

describe("M23.1 conector — rechazo de config de otro motor (sin red)", () => {
  it("connectPg rechaza una config MySQL con unsupported", async () => {
    const connector = getConnector("postgresql");
    await expect(connector.connect(mysqlConfig)).rejects.toBeInstanceOf(ConnectorError);
    await expect(connector.connect(mysqlConfig)).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("connectMysql rechaza una config PostgreSQL con unsupported", async () => {
    const connector = getConnector("mysql");
    await expect(connector.connect(pgConfig)).rejects.toMatchObject({
      code: "unsupported",
    });
  });
});

describe("M23.1 connectores — SQL parametrizado (sin red)", () => {
  it("PostgreSQL lista tablas con schema vinculado y lee con LIMIT/OFFSET", async () => {
    const query = vi.fn().mockResolvedValue([{ table_name: "users" }]);
    const conn = { query, close: vi.fn().mockResolvedValue(undefined) };
    const connector = getConnector("postgresql");

    const tables = await connector.listTables(conn, { namespace: "public" });
    expect(tables).toEqual([{ name: "users", namespace: "public" }]);
    const [listSql, listParams] = query.mock.calls[0] as [string, unknown[]];
    expect(listSql).toContain("information_schema.tables");
    // El schema va como parámetro vinculado, nunca interpolado.
    expect(listParams).toEqual(["public"]);
    expect(listSql).not.toContain("public");

    query.mockResolvedValue([{ id: 1 }]);
    await connector.readPage(conn, { name: "users" }, { limit: 10, offset: 20 });
    const [readSql, readParams] = query.mock.calls[1] as [string, unknown[]];
    expect(readSql).toBe('SELECT * FROM "users" LIMIT $1 OFFSET $2');
    expect(readParams).toEqual([10, 20]);
  });

  it("MySQL lista tablas con schema vinculado y lee con LIMIT/OFFSET", async () => {
    const query = vi.fn().mockResolvedValue([{ table_name: "clientes" }]);
    const conn = { query, close: vi.fn().mockResolvedValue(undefined) };
    const connector = getConnector("mysql");

    const tables = await connector.listTables(conn, { namespace: "crm" });
    expect(tables).toEqual([{ name: "clientes", namespace: "crm" }]);
    const [listSql, listParams] = query.mock.calls[0] as [string, unknown[]];
    expect(listSql).toContain("information_schema.tables");
    expect(listParams).toEqual(["crm"]);
    expect(listSql).not.toContain("crm");

    query.mockResolvedValue([{ id: 1 }]);
    await connector.readPage(conn, { name: "clientes" }, { limit: 5, offset: 10 });
    const [readSql, readParams] = query.mock.calls[1] as [string, unknown[]];
    expect(readSql).toBe("SELECT * FROM `clientes` LIMIT ? OFFSET ?");
    expect(readParams).toEqual([5, 10]);
  });

  it("MySQL falla cerrado si no hay namespace (nunca lista todos los schemas)", async () => {
    const conn = { query: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    await expect(getConnector("mysql").listTables(conn)).rejects.toMatchObject({
      code: "query_failed",
    });
    expect(conn.query).not.toHaveBeenCalled();
  });

  it("quotea identificadores hostiles en readPage (defensa ante inyección)", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const conn = { query, close: vi.fn().mockResolvedValue(undefined) };
    await getConnector("mysql").readPage(conn, { name: "a`; DROP TABLE x; --" }, { limit: 1, offset: 0 });
    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toBe("SELECT * FROM `a``; DROP TABLE x; --` LIMIT ? OFFSET ?");
  });
});
