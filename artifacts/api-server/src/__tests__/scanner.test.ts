/**
 * FASE 7.0.1 — Scanner PostgreSQL MVP.
 *
 * Unit: `runScan` con conector inyectado (happy path, sin matches, fuente no
 * escaneable, fallo de conexión) y resolución del catálogo de reglas.
 * Integración: `POST /api/scans` dispara el scanner real sobre una source
 * escaneable del mock y el scan termina `completed` con findings creados.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import { runScan, resolveActiveRules, BUILT_IN_RULES } from "../services/scanner";
import { connectPg, listTables, readPage, type PgConnector, type PgConnection } from "../connectors/postgres";
import type { MockState } from "./mock-repos";

process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.AUTH_BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-only";
process.env.AUTH_BOOTSTRAP_ENABLED = "true";
process.env.AUTH_REGISTRATION_ENABLED = "true";

const mocks = vi.hoisted(() => ({
  state: undefined as MockState | undefined,
  repos: undefined as unknown,
}));

vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn(), end: vi.fn() },
  pg: { Client: class MockClient {} },
}));
vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  const created = createMockRepos();
  mocks.state = created.state;
  mocks.repos = created.repos;
  return { repos: created.repos };
});
// El conector REAL se mockea a nivel de módulo para el test de integración
// HTTP (el camino feliz no debe abrir sockets). Los unit tests inyectan su
// propio conector y no dependen de este mock.
vi.mock("../connectors/postgres", async () => {
  const actual = await vi.importActual<typeof import("../connectors/postgres")>("../connectors/postgres");
  return {
    ...actual,
    connectPg: vi.fn(),
    listTables: vi.fn(),
    readPage: vi.fn(),
  };
});

function state(): MockState {
  if (!mocks.state) throw new Error("mock repos not initialized");
  return mocks.state;
}

function reposPatch(): {
  scans: {
    finalizeScan: (args: unknown) => Promise<unknown>;
    failScan: (args: unknown) => Promise<unknown>;
  };
} {
  if (!mocks.repos) throw new Error("mock repos not initialized");
  return mocks.repos as never;
}

/** Source escaneable para los tests (connectionConfig cifrado simulado). */
function addScannableSource(id: string): void {
  state().sources.push({
    id,
    name: "Scannable Source",
    kind: "postgresql",
    environment: "production",
    status: "healthy",
    lastScanAt: null,
    tables: 1,
    records: 2,
    connectionConfig: "mock-encrypted-connection-string",
    createdAt: new Date(),
    updatedAt: new Date(),
    findingsCount: 0,
  });
}

function fakeConnector(
  tables: string[],
  pages: Record<string, unknown>[][],
): PgConnector {
  const conn: PgConnection = {
    query: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  };
  let pageIndex = 0;
  return {
    connect: vi.fn().mockResolvedValue(conn),
    listTables: vi.fn().mockResolvedValue(tables),
    readPage: vi.fn().mockImplementation(async () => {
      const page = pages[Math.min(pageIndex, pages.length - 1)] ?? [];
      pageIndex += 1;
      return page;
    }),
  };
}

/** Sustituye las reglas del estado (tests de gobierno enabled/disabled, HIGH #1). */
function setRules(rules: { name: string; enabled: boolean }[]): void {
  state().rules = rules.map((rule, index) => ({
    id: `rule-702-${index + 1}`,
    name: rule.name,
    category: "gobierno",
    regulation: "TEST",
    enabled: rule.enabled,
    detections: 0,
    lastTriggered: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
}

/** Inserta un scan `running` previo a runScan (tests de ciclo de vida, HIGH #2). */
function addRunningScan(id: string, sourceId: string): void {
  state().scans.push({
    id,
    sourceId,
    status: "running",
    startedAt: new Date(),
    completedAt: null,
    findingsCreated: 0,
  });
}

describe("runScan (unit, conector inyectado)", () => {
  it("fuente no escaneable → failScan(source_not_scannable), sin conectar", async () => {
    const scans = reposPatch().scans;
    const failSpy = vi.spyOn(scans, "failScan");
    const finalizeSpy = vi.spyOn(scans, "finalizeScan");
    const connector = fakeConnector(["users"], [[{ contact: "x@example.com" }], []]);

    await runScan({ scanId: "scan-u1", sourceId: "src-001", connector });

    expect(failSpy).toHaveBeenCalledTimes(1);
    expect(failSpy).toHaveBeenCalledWith(expect.objectContaining({ reason: "source_not_scannable" }));
    expect(finalizeSpy).not.toHaveBeenCalled();
    expect((connector.connect as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    failSpy.mockRestore();
    finalizeSpy.mockRestore();
  });

  it("happy path → conecta, detecta PII y finaliza con findings", async () => {
    addScannableSource("src-scan-unit");
    const scans = reposPatch().scans;
    const failSpy = vi.spyOn(scans, "failScan");
    const finalizeSpy = vi.spyOn(scans, "finalizeScan");
    vi.mocked(listTables).mockResolvedValue(["users"]);

    const connector = fakeConnector(["users"], [
      [{ id: 1, contact: "ana@example.com", note: "texto inocuo" }],
      [],
    ]);

    await runScan({ scanId: "scan-u2", sourceId: "src-scan-unit", connector });

    expect(connector.connect).toHaveBeenCalledTimes(1);
    expect(finalizeSpy).toHaveBeenCalledTimes(1);
    const payload = finalizeSpy.mock.calls[0][0] as {
      scanId: string;
      sourceId: string;
      sourceName: string;
      findings: { location: string; dataType: string; records: number; sample: string }[];
    };
    expect(payload.scanId).toBe("scan-u2");
    expect(payload.sourceId).toBe("src-scan-unit");
    const emailFinding = payload.findings.find((f) => f.dataType === "email");
    expect(emailFinding).toBeDefined();
    expect(emailFinding?.location).toBe("users.contact");
    expect(emailFinding?.records).toBe(1);
    expect(emailFinding?.sample).toContain("ana@example.com");
    expect(failSpy).not.toHaveBeenCalled();

    failSpy.mockRestore();
    finalizeSpy.mockRestore();
  });

  it("sin matches → finaliza sin findings", async () => {
    addScannableSource("src-scan-clean");
    const scans = reposPatch().scans;
    const finalizeSpy = vi.spyOn(scans, "finalizeScan");
    vi.mocked(listTables).mockResolvedValue(["clean_table"]);

    const connector = fakeConnector(["clean_table"], [[{ id: 1, note: "nada que ver" }], []]);
    await runScan({ scanId: "scan-u3", sourceId: "src-scan-clean", connector });

    expect(finalizeSpy).toHaveBeenCalledTimes(1);
    const payload = finalizeSpy.mock.calls[0][0] as { findings: unknown[] };
    expect(payload.findings).toHaveLength(0);
    finalizeSpy.mockRestore();
  });

  it("fallo de conexión → failScan(connection_failed)", async () => {
    addScannableSource("src-scan-broken");
    const scans = reposPatch().scans;
    const failSpy = vi.spyOn(scans, "failScan");
    const finalizeSpy = vi.spyOn(scans, "finalizeScan");

    const connector: PgConnector = {
      connect: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      listTables: vi.fn(),
      readPage: vi.fn(),
    };
    await runScan({ scanId: "scan-u4", sourceId: "src-scan-broken", connector });

    expect(failSpy).toHaveBeenCalledTimes(1);
    expect(failSpy).toHaveBeenCalledWith(expect.objectContaining({ reason: "connection_failed" }));
    expect(finalizeSpy).not.toHaveBeenCalled();
    failSpy.mockRestore();
    finalizeSpy.mockRestore();
  });
});

describe("resolveActiveRules", () => {
  it("sin coincidencia de nombres con el seed → fallback al catálogo builtin", async () => {
    const rules = await resolveActiveRules();
    expect(rules).toEqual(BUILT_IN_RULES);
  });
});

describe("resolveActiveRules — gobierno enabled/disabled (HIGH #1, 7.0.2)", () => {
  let originalRules: MockState["rules"];

  beforeAll(() => {
    originalRules = state().rules;
  });

  afterEach(() => {
    state().rules = originalRules;
  });

  it("A: sin reglas en BD → catálogo builtin completo", async () => {
    setRules([]);
    const rules = await resolveActiveRules();
    expect(rules).toEqual(BUILT_IN_RULES);
  });

  it("B: builtin coincidente enabled=true → se ejecuta", async () => {
    setRules([{ name: "email", enabled: true }]);
    const rules = await resolveActiveRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.name).toBe("email");
  });

  it("C: builtin coincidente enabled=false → NO se ejecuta", async () => {
    setRules([{ name: "email", enabled: false }]);
    const rules = await resolveActiveRules();
    expect(rules.some((rule) => rule.name === "email")).toBe(false);
    // Las demás builtin siguen disponibles vía fallback (no están deshabilitadas).
    expect(rules).toHaveLength(3);
  });

  it("D: todas las builtin coincidentes disabled → no se ejecuta ninguna", async () => {
    setRules(BUILT_IN_RULES.map((rule) => ({ name: rule.name, enabled: false })));
    const rules = await resolveActiveRules();
    expect(rules).toEqual([]);
  });

  it("E: regla desconocida en BD → no altera el catálogo", async () => {
    setRules([{ name: "datos de salud", enabled: true }]);
    const rules = await resolveActiveRules();
    expect(rules).toEqual(BUILT_IN_RULES);
  });

  it("F: una conocida disabled + una conocida enabled → solo se ejecuta la enabled", async () => {
    setRules([
      { name: "email", enabled: false },
      { name: "phone", enabled: true },
    ]);
    const rules = await resolveActiveRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.name).toBe("phone");
  });
});

describe("runScan ciclo de vida — scans nunca stuck en running (HIGH #2, 7.0.2)", () => {
  it("finalizeScan lanza → scan failed(persist_failed) sin finalización exitosa", async () => {
    addScannableSource("src-scan-persist");
    addRunningScan("scan-f1", "src-scan-persist");
    const scans = reposPatch().scans;
    const finalizeSpy = vi.spyOn(scans, "finalizeScan").mockRejectedValue(new Error("db down"));
    const failSpy = vi.spyOn(scans, "failScan");
    vi.mocked(listTables).mockResolvedValue(["users"]);

    const connector = fakeConnector(["users"], [[{ contact: "x@example.com" }], []]);
    await expect(runScan({ scanId: "scan-f1", sourceId: "src-scan-persist", connector })).resolves.toBeUndefined();

    const scan = state().scans.find((item) => item.id === "scan-f1");
    expect(scan?.status).toBe("failed");
    expect(scan?.completedAt).not.toBeNull();
    expect(failSpy).toHaveBeenCalledWith(expect.objectContaining({ reason: "persist_failed" }));

    finalizeSpy.mockRestore();
    failSpy.mockRestore();
  });

  it("failScan también lanza → runScan resuelve sin unhandled rejection", async () => {
    addScannableSource("src-scan-double");
    addRunningScan("scan-f3", "src-scan-double");
    const scans = reposPatch().scans;
    const finalizeSpy = vi.spyOn(scans, "finalizeScan").mockRejectedValue(new Error("db down"));
    const failSpy = vi.spyOn(scans, "failScan").mockRejectedValue(new Error("db also down"));
    vi.mocked(listTables).mockResolvedValue(["users"]);

    const connector = fakeConnector(["users"], [[{ contact: "x@example.com" }], []]);
    await expect(runScan({ scanId: "scan-f3", sourceId: "src-scan-double", connector })).resolves.toBeUndefined();

    finalizeSpy.mockRestore();
    failSpy.mockRestore();
  });

  it("source eliminada entre startScan y runScan → failed(source_not_found), sin conectar", async () => {
    addRunningScan("scan-f4", "src-ghost-702");
    const scans = reposPatch().scans;
    const failSpy = vi.spyOn(scans, "failScan");

    const connector = fakeConnector(["users"], [[]]);
    await runScan({ scanId: "scan-f4", sourceId: "src-ghost-702", connector });

    const scan = state().scans.find((item) => item.id === "scan-f4");
    expect(scan?.status).toBe("failed");
    expect(failSpy).toHaveBeenCalledWith(expect.objectContaining({ reason: "source_not_found" }));
    expect((connector.connect as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    failSpy.mockRestore();
  });

  it("error de lectura → close() y failed(connection_failed)", async () => {
    addScannableSource("src-scan-readfail");
    addRunningScan("scan-f5", "src-scan-readfail");
    const scans = reposPatch().scans;
    const failSpy = vi.spyOn(scans, "failScan");

    const close = vi.fn().mockResolvedValue(undefined);
    const conn: PgConnection = { query: vi.fn().mockResolvedValue([]), close };
    const connector: PgConnector = {
      connect: vi.fn().mockResolvedValue(conn),
      listTables: vi.fn(),
      readPage: vi.fn(),
    };
    vi.mocked(listTables).mockRejectedValue(new Error("read exploded"));
    await runScan({ scanId: "scan-f5", sourceId: "src-scan-readfail", connector });

    expect(close).toHaveBeenCalledTimes(1);
    const scan = state().scans.find((item) => item.id === "scan-f5");
    expect(scan?.status).toBe("failed");
    expect(failSpy).toHaveBeenCalledWith(expect.objectContaining({ reason: "connection_failed" }));

    failSpy.mockRestore();
  });

  it("happy path con scan running real en estado → completed con findings", async () => {
    addScannableSource("src-scan-happy702");
    addRunningScan("scan-f6", "src-scan-happy702");
    vi.mocked(listTables).mockResolvedValue(["users"]);
    const connector = fakeConnector(["users"], [[{ contact: "x@example.com" }], []]);
    await runScan({ scanId: "scan-f6", sourceId: "src-scan-happy702", connector });

    const scan = state().scans.find((item) => item.id === "scan-f6");
    expect(scan?.status).toBe("completed");
    expect(scan?.completedAt).not.toBeNull();
    const created = state().findings.filter((finding) => finding.scanId === "scan-f6");
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(created.some((finding) => finding.location === "users.contact" && finding.dataType === "email")).toBe(true);
  });
});

describe("Integración HTTP: POST /api/scans dispara el scanner real", () => {
  let server: ReturnType<Express["listen"]>;
  let adminCookie: string;

  beforeAll(async () => {
    server = app.listen(0);
    const boot = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "10.95.0.1")
      .send({ token: "bootstrap-token-for-tests-only" });
    expect(boot.status).toBe(200);
    adminCookie = boot.headers["set-cookie"][0].split(";")[0];
  });

  afterAll(() => {
    server.close();
  });

  it("202 + scan completed con findings del conector mockeado", async () => {
    addScannableSource("src-scan-http");
    vi.mocked(connectPg).mockResolvedValue({
      query: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(listTables).mockResolvedValue(["customers"]);
    vi.mocked(readPage)
      .mockResolvedValueOnce([
        { id: 1, contact: "cliente@empresa.com", doc: "27.442.918-6" },
      ])
      .mockResolvedValueOnce([]);

    const res = await request(server)
      .post("/api/scans")
      .set("Cookie", adminCookie)
      .send({ sourceId: "src-scan-http" });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("running");

    // El scanner corre en background: esperar a que termine.
    await new Promise((resolve) => setTimeout(resolve, 120));

    const scan = state().scans.find((s) => s.id === res.body.id);
    expect(scan?.status).toBe("completed");
    const created = state().findings.filter((f) => f.scanId === res.body.id);
    expect(created.length).toBeGreaterThanOrEqual(2);
    expect(created.some((f) => f.location === "customers.contact" && f.dataType === "email")).toBe(true);
    expect(created.some((f) => f.location === "customers.doc" && f.dataType === "national_id")).toBe(true);
  });
});

describe("BUILT_IN_RULES.credit_card — patrón lineal (FASE 7.0.3)", () => {
  const pattern = BUILT_IN_RULES.find((rule) => rule.name === "credit_card")!.pattern;

  it("detecta formatos PAN estándar (paridad con el patrón anterior)", () => {
    expect(pattern.test("4111 1111 1111 1111")).toBe(true);
    expect(pattern.test("4111-1111-1111-1111")).toBe(true);
    expect(pattern.test("4111111111111111")).toBe(true);
  });

  it("rechaza secuencias cortas y texto inocuo", () => {
    expect(pattern.test("4111 1111 1111")).toBe(false); // 12 dígitos
    expect(pattern.test("no hay nada aquí")).toBe(false);
  });
});

describe("Límites de volumen (FASE 7.0.3)", () => {
  it("MAX_FIELD_LENGTH: PAN íntegro dentro de la ventana de un campo largo → detectado", async () => {
    addScannableSource("src-scan-win-in");
    addRunningScan("scan-v1", "src-scan-win-in");
    const pan = "4111111111111111";
    const blob = ".".repeat(4080) + pan; // 4096 chars: PAN íntegro en la ventana
    vi.mocked(listTables).mockResolvedValue(["blobs"]);
    const connector = fakeConnector(["blobs"], [[{ payload: blob }], []]);

    await runScan({ scanId: "scan-v1", sourceId: "src-scan-win-in", connector });

    const created = state().findings.filter((finding) => finding.scanId === "scan-v1");
    expect(created.some((finding) => finding.dataType === "credit_card" && finding.location === "blobs.payload")).toBe(true);
  });

  it("MAX_FIELD_LENGTH: PAN fuera de la ventana (tras 4096 chars) → no detectado", async () => {
    addScannableSource("src-scan-win-out");
    addRunningScan("scan-v2", "src-scan-win-out");
    const pan = "4111111111111111";
    const blob = ".".repeat(4096) + pan; // el PAN comienza en la posición 4097
    vi.mocked(listTables).mockResolvedValue(["blobs"]);
    const connector = fakeConnector(["blobs"], [[{ payload: blob }], []]);

    await runScan({ scanId: "scan-v2", sourceId: "src-scan-win-out", connector });

    const created = state().findings.filter((finding) => finding.scanId === "scan-v2");
    expect(created.some((finding) => finding.dataType === "credit_card")).toBe(false);
  });

  it("campo adversarial masivo (guard ReDoS, sin aserciones de tiempo) → completa", async () => {
    addScannableSource("src-scan-redos");
    addRunningScan("scan-v3", "src-scan-redos");
    const adversarial = "1 ".repeat(3000); // 6000 chars alternando dígito/separador
    vi.mocked(listTables).mockResolvedValue(["logs"]);
    const connector = fakeConnector(["logs"], [[{ payload: adversarial }], []]);

    await runScan({ scanId: "scan-v3", sourceId: "src-scan-redos", connector });

    const scan = state().scans.find((item) => item.id === "scan-v3");
    expect(scan?.status).toBe("completed");
  });

  it("MAX_TABLES_PER_SCAN: 120 tablas → solo se leen 100", async () => {
    addScannableSource("src-scan-tcap");
    addRunningScan("scan-v4", "src-scan-tcap");
    const tables = Array.from({ length: 120 }, (_, index) => `t${String(index).padStart(3, "0")}`);
    vi.mocked(listTables).mockResolvedValue(tables);
    const connector = fakeConnector(tables, [[]]);

    await runScan({ scanId: "scan-v4", sourceId: "src-scan-tcap", connector });

    expect((connector.readPage as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(100);
    const scan = state().scans.find((item) => item.id === "scan-v4");
    expect(scan?.status).toBe("completed");
  });

  it("MAX_TABLES_PER_SCAN en la frontera: 100 tablas → se leen 100", async () => {
    addScannableSource("src-scan-tcap-boundary");
    addRunningScan("scan-v5", "src-scan-tcap-boundary");
    const tables = Array.from({ length: 100 }, (_, index) => `t${String(index).padStart(3, "0")}`);
    vi.mocked(listTables).mockResolvedValue(tables);
    const connector = fakeConnector(tables, [[]]);

    await runScan({ scanId: "scan-v5", sourceId: "src-scan-tcap-boundary", connector });

    expect((connector.readPage as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(100);
    const scan = state().scans.find((item) => item.id === "scan-v5");
    expect(scan?.status).toBe("completed");
  });
});