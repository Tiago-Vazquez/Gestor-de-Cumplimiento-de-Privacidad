/**
 * M23.1 — Integración REAL de la capa de conectores contra motores reales.
 *
 * Estos tests abren sockets de verdad y quedan SALTADOS por defecto: solo
 * corren si el entorno declara los contenedores. Arranque documentado (el
 * andamiaje completo está en el reporte de entrega M23.1):
 *
 *   docker run -d --name m23-mysql -e MYSQL_ROOT_PASSWORD=... -e MYSQL_DATABASE=m23crm \
 *     -e MYSQL_USER=m23user -e MYSQL_PASSWORD=... -p 33306:3306 mysql:8.4
 *   docker run -d --name m23-pg -e POSTGRES_USER=m23user -e POSTGRES_PASSWORD=... \
 *     -e POSTGRES_DB=m23app -p 55432:5432 postgres:16-alpine
 *
 * y luego `pnpm --filter @workspace/api-server run test:integration` con las
 * envs M23_* correspondientes.
 *
 *   M23_MYSQL_HOST / M23_MYSQL_PORT / M23_MYSQL_USER / M23_MYSQL_PASSWORD / M23_MYSQL_DATABASE
 *   M23_PG_HOST    / M23_PG_PORT    / M23_PG_USER    / M23_PG_PASSWORD    / M23_PG_DATABASE
 *
 * Qué se verifica (no simulado):
 *  - connect/listTables/readPage (LIMIT/OFFSET) reales y cierre efectivo (`close`);
 *  - quoting real de identificadores hostiles (backtick en MySQL, comilla en PG);
 *  - clasificación de errores: credenciales inválidas, host inalcanzable, timeout
 *    de conexión y timeout de query (watchdog MySQL / statement_timeout PG);
 *  - end-to-end: `runScan` con el conector REAL produce findings y cierra la
 *    conexión, sin filtrar credenciales en los errores.
 *
 * El repo de persistencia se mockea (mock-repos): lo que se prueba es el
 * conector, no la base de la plataforma.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { getConnector } from "../connectors/registry";
import { ConnectorError, type ConnectionConfig, type SourceConnector } from "../connectors/types";
import { connectMysql } from "../connectors/mysql";
import { connectPg } from "../connectors/postgres";
import { runScan } from "../services/scanner";
import type { MockState } from "./mock-repos";

const mocks = vi.hoisted(() => {
  process.env.AUTH_DISABLED = "false";
  process.env.JWT_SECRET ??= "test-secret-of-at-least-32-characters!!";
  process.env.SOURCE_ENCRYPTION_KEY ??= "test-source-encryption-key-of-at-least-32-characters!!";
  // `@workspace/db` exige DATABASE_URL al importarse (crea el pool de la
  // plataforma, que aquí NO se usa porque `../repositories` está mockeado).
  // Lo único que aprovechamos del módulo es el re-export del driver `pg`.
  process.env.DATABASE_URL ??= "postgresql://m23user:m23-secret-pass@127.0.0.1:55432/m23app";
  process.env.BG_DATABASE_URL ??= process.env.DATABASE_URL;
  return { state: undefined as MockState | undefined, repos: undefined as unknown };
});

vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  const created = createMockRepos();
  mocks.state = created.state;
  mocks.repos = created.repos;
  return { repos: created.repos };
});

function state(): MockState {
  if (!mocks.state) throw new Error("mock repos not initialized");
  return mocks.state;
}

interface ScanRepoSpies {
  scans: {
    finalizeScan: (...args: never[]) => Promise<unknown>;
    failScan: (...args: never[]) => Promise<unknown>;
    heartbeatScan: (...args: never[]) => Promise<unknown>;
  };
  sources: { decryptConnectionConfig: (...args: never[]) => ConnectionConfig | null };
}

function reposApi(): ScanRepoSpies {
  if (!mocks.repos) throw new Error("mock repos not initialized");
  return mocks.repos as never;
}

const num = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const MYSQL_ENV = {
  host: process.env.M23_MYSQL_HOST ?? "",
  port: num(process.env.M23_MYSQL_PORT, 3306),
  database: process.env.M23_MYSQL_DATABASE ?? "",
  user: process.env.M23_MYSQL_USER ?? "",
  password: process.env.M23_MYSQL_PASSWORD ?? "",
};

const PG_ENV = {
  host: process.env.M23_PG_HOST ?? "",
  port: num(process.env.M23_PG_PORT, 5432),
  database: process.env.M23_PG_DATABASE ?? "",
  user: process.env.M23_PG_USER ?? "",
  password: process.env.M23_PG_PASSWORD ?? "",
};

const MYSQL_READY = Boolean(
  MYSQL_ENV.host && MYSQL_ENV.user && MYSQL_ENV.password && MYSQL_ENV.database,
);
const PG_READY = Boolean(PG_ENV.host && PG_ENV.user && PG_ENV.password && PG_ENV.database);

const mysqlConfig = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  kind: "mysql",
  host: MYSQL_ENV.host,
  port: MYSQL_ENV.port,
  database: MYSQL_ENV.database,
  user: MYSQL_ENV.user,
  password: MYSQL_ENV.password,
  ...over,
});

const pgConfig = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  kind: "postgresql",
  host: PG_ENV.host,
  port: PG_ENV.port,
  database: PG_ENV.database,
  user: PG_ENV.user,
  password: PG_ENV.password,
  ...over,
});

/** Ajusta una env de timeout durante un test y la restaura siempre. */
const withTimeoutEnv = (key: string, value: string): void => {
  const original = process.env[key];
  process.env[key] = value;
  restore.push(() => {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  });
};
const restore: Array<() => void> = [];

afterEach(() => {
  while (restore.length > 0) restore.pop()?.();
});

describe.skipIf(!MYSQL_READY)("M23.1 integración real — MySQL", () => {
  const connector = getConnector("mysql");
  const otherNamespace = process.env.M23_MYSQL_OTHER_DATABASE;

  it("connect + listTables del namespace default + readPage paginado con datos reales", async () => {
    const conn = await connector.connect(mysqlConfig());
    try {
      const names = (await connector.listTables(conn)).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["clientes", "notas", "weird`name"]));
      // El namespace default es la database de la config: no ve otras bases.
      expect(names).not.toContain("ajeno");

      const first = await connector.readPage(conn, { name: "clientes" }, { limit: 2, offset: 0 });
      const second = await connector.readPage(conn, { name: "clientes" }, { limit: 2, offset: 2 });
      expect(first).toHaveLength(2);
      expect(second).toHaveLength(1);
      expect([...first, ...second].map((row) => Number(row.id)).sort()).toEqual([1, 2, 3]);
      expect(JSON.stringify(first)).toContain("@example.com");
      expect(JSON.stringify(first)).toContain("4111 1111 1111 1111");
    } finally {
      await conn.close();
    }
  });

  it("quotea identificadores hostiles reales (tabla con backtick)", async () => {
    const conn = await connector.connect(mysqlConfig());
    try {
      const rows = await connector.readPage(conn, { name: "weird`name" }, { limit: 10, offset: 0 });
      expect(rows).toHaveLength(2);
      expect(JSON.stringify(rows)).toContain("hostil@example.com");
    } finally {
      await conn.close();
    }
  });

  it.skipIf(!otherNamespace)("namespace explícito distinto del default (aislamiento entre bases)", async () => {
    const conn = await connector.connect(mysqlConfig());
    try {
      const tables = await connector.listTables(conn, { namespace: otherNamespace });
      expect(tables.map((t) => t.name)).toEqual(["ajeno"]);
    } finally {
      await conn.close();
    }
  });

  it("close() cierra la conexión: las lecturas posteriores fallan", async () => {
    const conn = await connector.connect(mysqlConfig());
    await conn.close();
    await expect(
      connector.readPage(conn, { name: "clientes" }, { limit: 1, offset: 0 }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it("credenciales inválidas → auth_failed, sin filtrar la contraseña", async () => {
    const secret = "definitely-wrong-password-777";
    let thrown: unknown;
    try {
      await connector.connect(mysqlConfig({ password: secret }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConnectorError);
    expect((thrown as ConnectorError).code).toBe("auth_failed");
    expect((thrown as Error).message).not.toContain(secret);
    expect(JSON.stringify({ ...(thrown as object) })).not.toContain(secret);
  });

  it("host inalcanzable → unreachable", async () => {
    await expect(
      connector.connect(mysqlConfig({ host: "127.0.0.1", port: 1 })),
    ).rejects.toMatchObject({ code: "unreachable" });
  });

  it("timeout de conexión real (IP no ruteable con 1s)", async () => {
    withTimeoutEnv("SOURCE_CONNECT_TIMEOUT_MS", "1000");
    await expect(
      connector.connect(mysqlConfig({ host: "10.255.255.1", port: 3306 })),
    ).rejects.toMatchObject({ code: "timeout" });
  }, 20_000);

  it("watchdog de query real: SELECT SLEEP(3) con 800ms → timeout", async () => {
    withTimeoutEnv("SOURCE_QUERY_TIMEOUT_MS", "800");
    const conn = await connectMysql(mysqlConfig());
    try {
      await expect(conn.query("SELECT SLEEP(3)")).rejects.toMatchObject({ code: "timeout" });
    } finally {
      await conn.close();
    }
  }, 20_000);
});
describe.skipIf(!PG_READY)("M23.1 integración real — PostgreSQL", () => {
  const connector = getConnector("postgresql");
  const otherNamespace = process.env.M23_PG_OTHER_SCHEMA;

  it("connect + listTables del schema public + readPage paginado con datos reales", async () => {
    const conn = await connector.connect(pgConfig());
    try {
      const names = (await connector.listTables(conn)).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["clientes", "notas", 'we"ird']));
      expect(names).not.toContain("ajeno");

      const first = await connector.readPage(conn, { name: "clientes" }, { limit: 2, offset: 0 });
      const second = await connector.readPage(conn, { name: "clientes" }, { limit: 2, offset: 2 });
      expect(first).toHaveLength(2);
      expect(second).toHaveLength(1);
      expect([...first, ...second].map((row) => Number(row.id)).sort()).toEqual([1, 2, 3]);
      expect(JSON.stringify(first)).toContain("@example.com");
    } finally {
      await conn.close();
    }
  });

  it("quotea identificadores hostiles reales (tabla con comilla doble)", async () => {
    const conn = await connector.connect(pgConfig());
    try {
      const rows = await connector.readPage(conn, { name: 'we"ird' }, { limit: 10, offset: 0 });
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).toContain("hostil@example.com");
    } finally {
      await conn.close();
    }
  });

  it.skipIf(!otherNamespace)("namespace explícito distinto de public (aislamiento de schemas)", async () => {
    const conn = await connector.connect(pgConfig());
    try {
      const tables = await connector.listTables(conn, { namespace: otherNamespace });
      expect(tables.map((t) => t.name)).toEqual(["ajeno"]);
    } finally {
      await conn.close();
    }
  });

  it("close() cierra la conexión: las lecturas posteriores fallan", async () => {
    const conn = await connector.connect(pgConfig());
    await conn.close();
    await expect(
      connector.readPage(conn, { name: "clientes" }, { limit: 1, offset: 0 }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it("credenciales inválidas → auth_failed, sin filtrar la contraseña", async () => {
    const secret = "definitely-wrong-password-777";
    let thrown: unknown;
    try {
      await connector.connect(pgConfig({ password: secret }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConnectorError);
    expect((thrown as ConnectorError).code).toBe("auth_failed");
    expect((thrown as Error).message).not.toContain(secret);
    expect(JSON.stringify({ ...(thrown as object) })).not.toContain(secret);
  });

  it("host inalcanzable → unreachable", async () => {
    await expect(
      connector.connect(pgConfig({ host: "127.0.0.1", port: 1 })),
    ).rejects.toMatchObject({ code: "unreachable" });
  });

  it("timeout de conexión real (IP no ruteable con 1s)", async () => {
    withTimeoutEnv("SOURCE_CONNECT_TIMEOUT_MS", "1000");
    await expect(
      connector.connect(pgConfig({ host: "10.255.255.1", port: 5432 })),
    ).rejects.toMatchObject({ code: "timeout" });
  }, 20_000);

  it("statement_timeout server-side real: pg_sleep(3) con 800ms → timeout", async () => {
    withTimeoutEnv("SOURCE_QUERY_TIMEOUT_MS", "800");
    const conn = await connectPg(pgConfig());
    try {
      await expect(conn.query("SELECT pg_sleep(3)")).rejects.toMatchObject({ code: "timeout" });
    } finally {
      await conn.close();
    }
  }, 20_000);
});

/** Envuelve un conector real para observar el cierre efectivo del handle. */
function observeClose(base: SourceConnector): { connector: SourceConnector; wasClosed: () => boolean } {
  let closed = false;
  const connector: SourceConnector = {
    ...base,
    async connect(config) {
      const conn = await base.connect(config);
      return {
        ...conn,
        async close() {
          closed = true;
          await conn.close();
        },
      };
    },
  };
  return { connector, wasClosed: () => closed };
}

/** Fuente escaneable en el estado del mock (org canónica M21.5). */
function pushScannableSource(id: string, kind: "postgresql" | "mysql"): void {
  state().sources.push({
    id,
    name: `Integración ${kind}`,
    kind,
    environment: "production",
    status: "healthy",
    lastScanAt: null,
    tables: 0,
    records: 0,
    connectionConfig: "mock-encrypted-connection-string",
    createdAt: new Date(),
    updatedAt: new Date(),
    findingsCount: 0,
    tenantId: "org-bootstrap",
  });
}

interface FinalizeArgs {
  findings: { location: string; dataType: string; severity: string; records: number }[];
  scannedTables: number;
  recordsRead: number;
}

describe("M23.1 end-to-end — scan REAL vía registry", () => {
  it.skipIf(!MYSQL_READY)("MySQL: findings por contenido, conexión cerrada y sin failScan", async () => {
    pushScannableSource("src-it-scan-mysql", "mysql");
    const api = reposApi();
    const decrypt = vi.spyOn(api.sources, "decryptConnectionConfig").mockReturnValue(mysqlConfig());
    const finalize = vi.spyOn(api.scans, "finalizeScan");
    const fail = vi.spyOn(api.scans, "failScan");
    const { connector, wasClosed } = observeClose(getConnector("mysql"));

    await runScan({ scanId: "scan-it-mysql", sourceId: "src-it-scan-mysql", connector });

    expect(fail).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledTimes(1);
    const args = finalize.mock.calls[0][0] as unknown as FinalizeArgs;
    expect(args.findings.length).toBeGreaterThan(0);
    expect(args.findings.map((f) => f.location)).toEqual(
      expect.arrayContaining(["clientes.email", "clientes.tarjeta", "clientes.telefono"]),
    );
    expect(args.findings.some((f) => f.severity === "critical")).toBe(true);
    expect(args.scannedTables).toBeGreaterThanOrEqual(3);
    // El handle real se cerró (no quedan conexiones colgadas al motor).
    expect(wasClosed()).toBe(true);
    // El payload persistido no contiene la contraseña de la fuente.
    expect(JSON.stringify(args)).not.toContain(MYSQL_ENV.password);

    decrypt.mockRestore();
    finalize.mockRestore();
    fail.mockRestore();
  }, 30_000);

  it.skipIf(!PG_READY)("PostgreSQL: findings por contenido, conexión cerrada y sin failScan", async () => {
    pushScannableSource("src-it-scan-pg", "postgresql");
    const api = reposApi();
    const decrypt = vi.spyOn(api.sources, "decryptConnectionConfig").mockReturnValue(pgConfig());
    const finalize = vi.spyOn(api.scans, "finalizeScan");
    const fail = vi.spyOn(api.scans, "failScan");
    const { connector, wasClosed } = observeClose(getConnector("postgresql"));

    await runScan({ scanId: "scan-it-pg", sourceId: "src-it-scan-pg", connector });

    expect(fail).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledTimes(1);
    const args = finalize.mock.calls[0][0] as unknown as FinalizeArgs;
    expect(args.findings.map((f) => f.location)).toEqual(
      expect.arrayContaining(["clientes.email", "clientes.tarjeta", "clientes.telefono"]),
    );
    expect(wasClosed()).toBe(true);
    expect(JSON.stringify(args)).not.toContain(PG_ENV.password);

    decrypt.mockRestore();
    finalize.mockRestore();
    fail.mockRestore();
  }, 30_000);

  it.skipIf(!MYSQL_READY)("credenciales inválidas → failScan(connection_failed) sin filtrar el secreto", async () => {
    const secret = "wrong-scan-password-999";
    pushScannableSource("src-it-scan-mysql-bad", "mysql");
    const api = reposApi();
    const decrypt = vi
      .spyOn(api.sources, "decryptConnectionConfig")
      .mockReturnValue(mysqlConfig({ password: secret }));
    const fail = vi.spyOn(api.scans, "failScan");
    const finalize = vi.spyOn(api.scans, "finalizeScan");

    await runScan({
      scanId: "scan-it-mysql-bad",
      sourceId: "src-it-scan-mysql-bad",
      connector: getConnector("mysql"),
    });

    expect(fail).toHaveBeenCalledTimes(1);
    expect(finalize).not.toHaveBeenCalled();
    const failArgs = fail.mock.calls[0][0] as unknown;
    expect(failArgs).toMatchObject({ reason: "connection_failed" });
    expect(JSON.stringify(failArgs)).not.toContain(secret);

    decrypt.mockRestore();
    fail.mockRestore();
    finalize.mockRestore();
  }, 30_000);
});

