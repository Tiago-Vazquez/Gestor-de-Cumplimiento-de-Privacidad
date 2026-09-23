/**
 * M17 — Auditoría administrativa y trazabilidad.
 *
 * Cobertura:
 * - Registro de eventos en acciones administrativas HTTP (login/logout y
 *   sesiones, usuarios y roles, fuentes y horarios, reglas, scans, informes y
 *   masking) con actor autenticado y correlation id (M16) cuando existe.
 * - Eventos internos sin actor humano: scheduler (`scan_started` con
 *   `origin: "scheduler"`) y reaper (`scan_failed` con `origin: "recovery"`),
 *   ambos con `actorUserId: null` (FASE 4 de M17).
 * - Saneado de metadata: nunca secretos (contraseñas, tokens, JWT, cookies,
 *   CSRF, claves, connectionConfig) ni objetos anidados.
 * - GET /api/audit-events: solo admin (401 anónimo / 403 auditor), filtros
 *   combinables, paginación (limit/offset) y 400 en filtros inválidos.
 * - Best-effort: si la escritura de auditoría falla, la acción auditada sigue
 *   respondiendo igual (nunca rompe el flujo de negocio).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import { repos } from "../repositories";
import type { MockState } from "./mock-repos";
import { fetchCsrfToken } from "./test-utils";
import { sanitizeAuditMetadata } from "../lib/audit";
import { runSchedulerTick } from "../services/scan-scheduler";
import { recoverOrphanedScansAtBoot } from "../services/scan-recovery";

process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.SOURCE_ENCRYPTION_KEY = "test-source-encryption-key-of-at-least-32-characters!!";
process.env.AUTH_BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-only";
process.env.AUTH_BOOTSTRAP_ENABLED = "true";
process.env.AUTH_REGISTRATION_ENABLED = "true";

const BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-only";
const AUDITOR_EMAIL = "auditor-audit@example.com";
const AUDITOR_PASSWORD = "secure-password-123";
const SESSIONS_EMAIL = "auditor-sessions@example.com";

const mocks = vi.hoisted(() => ({ state: undefined as MockState | undefined }));
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(), end: vi.fn() } }));
vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  const created = createMockRepos();
  mocks.state = created.state;
  return { repos: created.repos };
});

function state(): MockState {
  if (!mocks.state) throw new Error("mock repos not initialized");
  return mocks.state;
}

/** Eventos persistidos, más recientes primero (como los inserta el mock). */
function events() {
  return state().auditEvents;
}

function byAction(action: string) {
  return events().filter((event) => event.action === action);
}

let ipSeq = 0;
const nextIp = (): string => `10.93.9.${++ipSeq}`;

function cookieOf(res: { headers: { [k: string]: unknown } }): string {
  const set = res.headers["set-cookie"] as string[] | string | undefined;
  const arr = Array.isArray(set) ? set : set ? [set] : [];
  const hit = arr.find((c) => c.startsWith("session="));
  if (!hit) throw new Error("session cookie not found");
  return hit.split(";")[0];
}

/** Config de conexión mínima para habilitar el camino de éxito del masking. */
const MOCK_CONFIG = {
  host: "db.internal",
  port: 5432,
  database: "app",
  user: "reader",
  password: "unused-in-mock",
  sslMode: "require",
} as unknown as MockState["sources"][number]["connectionConfig"];

/** Siembra un scan `running` (el scanner real no participa en estos tests). */
function addRunningScan(id: string, sourceId: string): void {
  state().scans.push({
    id,
    sourceId,
    status: "running",
    startedAt: new Date(),
    completedAt: null,
    findingsCreated: 0,
    heartbeatAt: null,
    tablesScanned: 0,
    recordsRead: 0,
    cancelRequested: false,
  });
}

describe("M17 — auditoría administrativa", () => {
  let server: ReturnType<Express["listen"]>;
  let adminCookie: string;
  let adminCsrf: string;
  let auditorSub: string;
  let auditorCookie: string;
  let auditorCsrf: string;
  let sessionsSub: string;

  beforeAll(async () => {
    server = app.listen(0);

    const boot = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", nextIp())
      .send({ token: BOOTSTRAP_TOKEN });
    expect(boot.status).toBe(200);
    adminCookie = cookieOf(boot);
    adminCsrf = await fetchCsrfToken(server, adminCookie);

    const reg = await request(server)
      .post("/api/auth/register")
      .set("X-Forwarded-For", nextIp())
      .send({ email: AUDITOR_EMAIL, password: AUDITOR_PASSWORD });
    expect(reg.status).toBe(201);
    auditorSub = reg.body.sub as string;

    const login = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", nextIp())
      .send({ email: AUDITOR_EMAIL, password: AUDITOR_PASSWORD });
    expect(login.status).toBe(200);
    auditorCookie = cookieOf(login);
    auditorCsrf = await fetchCsrfToken(server, auditorCookie);

    // Usuario dedicado a las acciones que revocan TODAS las sesiones
    // (logout-all), para no invalidar las cookies del resto de la suite.
    const sessionsReg = await request(server)
      .post("/api/auth/register")
      .set("X-Forwarded-For", nextIp())
      .send({ email: SESSIONS_EMAIL, password: AUDITOR_PASSWORD });
    expect(sessionsReg.status).toBe(201);
    sessionsSub = sessionsReg.body.sub as string;
  });

  afterAll(() => {
    server.close();
  });

  describe("login y sesiones", () => {
    it("audita el login bootstrap con actor y el X-Request-Id del request", async () => {
      const res = await request(server)
        .post("/api/auth/login")
        .set("X-Forwarded-For", nextIp())
        .set("X-Request-Id", "audit-corr-bootstrap")
        .send({ token: BOOTSTRAP_TOKEN });
      expect(res.status).toBe(200);

      const event = byAction("login_success").find(
        (e) => e.requestId === "audit-corr-bootstrap",
      );
      expect(event).toBeDefined();
      expect(event?.actorUserId).toBe("bootstrap-admin");
      expect(event?.resourceType).toBe("session");
      expect(event?.result).toBe("success");
      expect(event?.metadata).toMatchObject({ method: "bootstrap" });
    });

    it("audita el login local exitoso sin secretos", async () => {
      const res = await request(server)
        .post("/api/auth/login")
        .set("X-Forwarded-For", nextIp())
        .send({ email: AUDITOR_EMAIL, password: AUDITOR_PASSWORD });
      expect(res.status).toBe(200);

      const event = byAction("login_success").find((e) => e.actorUserId === auditorSub);
      expect(event).toBeDefined();
      expect(event?.metadata).toMatchObject({ method: "local" });
      expect(JSON.stringify(event?.metadata)).not.toContain(AUDITOR_PASSWORD);
    });

    it("audita el login fallido como failure, sin contraseña ni email", async () => {
      const res = await request(server)
        .post("/api/auth/login")
        .set("X-Forwarded-For", nextIp())
        .send({ email: AUDITOR_EMAIL, password: "wrong-password-123" });
      expect(res.status).toBe(401);

      const event = byAction("login_failure")[0];
      expect(event.actorUserId).toBeNull();
      expect(event.result).toBe("failure");
      expect(event.resourceType).toBe("session");
      expect(event.metadata).toMatchObject({ method: "local", reason: "invalid_password" });

      const serialized = JSON.stringify(event.metadata);
      expect(serialized).not.toContain("wrong-password-123");
      expect(serialized).not.toContain(AUDITOR_EMAIL);
    });

    it("audita logout-all con el contador de sesiones revocadas", async () => {
      const login = await request(server)
        .post("/api/auth/login")
        .set("X-Forwarded-For", nextIp())
        .send({ email: SESSIONS_EMAIL, password: AUDITOR_PASSWORD });
      expect(login.status).toBe(200);
      const cookie = cookieOf(login);
      const csrf = await fetchCsrfToken(server, cookie);

      const res = await request(server)
        .post("/api/auth/logout-all")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", cookie)
        .set("X-CSRF-Token", csrf);
      expect(res.status).toBe(200);

      const event = byAction("logout_all")[0];
      expect(event.actorUserId).toBe(sessionsSub);
      expect(event.resourceType).toBe("session");
      expect(Number(event.metadata.revoked)).toBeGreaterThanOrEqual(1);
    });

    it("audita la revocación de una sesión concreta y el logout", async () => {
      const other = await request(server)
        .post("/api/auth/login")
        .set("X-Forwarded-For", nextIp())
        .send({ email: SESSIONS_EMAIL, password: AUDITOR_PASSWORD });
      expect(other.status).toBe(200);
      const otherCookie = cookieOf(other);

      const current = await request(server)
        .post("/api/auth/login")
        .set("X-Forwarded-For", nextIp())
        .send({ email: SESSIONS_EMAIL, password: AUDITOR_PASSWORD });
      expect(current.status).toBe(200);
      const currentCookie = cookieOf(current);
      const currentCsrf = await fetchCsrfToken(server, currentCookie);

      const list = await request(server)
        .get("/api/auth/sessions")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", currentCookie);
      expect(list.status).toBe(200);
      const target = (list.body.sessions as { jti: string; current: boolean }[]).find(
        (session) => !session.current,
      );
      expect(target).toBeDefined();

      const res = await request(server)
        .delete(`/api/auth/sessions/${target?.jti}`)
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", currentCookie)
        .set("X-CSRF-Token", currentCsrf);
      expect(res.status).toBe(200);

      const event = byAction("session_revoked")[0];
      expect(event.actorUserId).toBe(sessionsSub);
      expect(event.resourceId).toBe(target?.jti);

      // El logout del mismo usuario también queda trazado (jti del JWT válido).
      const logout = await request(server)
        .post("/api/auth/logout")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", otherCookie);
      expect(logout.status).toBe(204);
      const logoutEvent = byAction("logout")[0];
      expect(logoutEvent.actorUserId).toBe(sessionsSub);
      expect(typeof logoutEvent.resourceId).toBe("string");
    });
  });

  describe("usuarios", () => {
    it("audita la edición de un usuario con los campos modificados", async () => {
      const res = await request(server)
        .patch(`/api/users/${auditorSub}`)
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ name: "Auditor Auditado" });
      expect(res.status).toBe(200);

      const event = byAction("user_updated")[0];
      expect(event.actorUserId).toBe("bootstrap-admin");
      expect(event.resourceType).toBe("user");
      expect(event.resourceId).toBe(auditorSub);
      // Solo NOMBRES de campos: el email (dato personal) no se persiste.
      expect(event.metadata).toEqual({ fields: ["name"] });
    });

    it("audita el cambio de roles con el conjunto efectivo y sesiones revocadas", async () => {
      const reg = await request(server)
        .post("/api/auth/register")
        .set("X-Forwarded-For", nextIp())
        .send({ email: "roles-target@example.com", password: AUDITOR_PASSWORD });
      expect(reg.status).toBe(201);
      const sub = reg.body.sub as string;

      const res = await request(server)
        .patch(`/api/users/${sub}/roles`)
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ roles: ["auditor", "admin"] });
      expect(res.status).toBe(200);

      const event = byAction("user_roles_updated")[0];
      expect(event.actorUserId).toBe("bootstrap-admin");
      expect(event.resourceId).toBe(sub);
      expect(event.metadata).toMatchObject({
        roles: ["auditor", "admin"],
        changed: true,
        revokedSessions: 0,
      });
    });
  });

  describe("fuentes y horarios", () => {
    it("audita la creación de fuente sin credenciales de conexión", async () => {
      const res = await request(server)
        .post("/api/sources")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({
          name: "Audited PostgreSQL",
          kind: "postgresql",
          environment: "staging",
          connection: {
            host: "db.audit.local",
            port: 5432,
            database: "app",
            user: "reader",
            password: "super-secret-connection-password",
          },
        });
      expect(res.status).toBe(201);

      const event = byAction("source_created")[0];
      expect(event.actorUserId).toBe("bootstrap-admin");
      expect(event.resourceId).toBe(res.body.id);
      expect(event.metadata).toMatchObject({
        kind: "postgresql",
        environment: "staging",
        scannable: true,
      });

      const serialized = JSON.stringify(event.metadata);
      expect(serialized).not.toContain("super-secret-connection-password");
      expect(serialized).not.toContain("db.audit.local");
      expect(serialized).not.toContain("reader");
    });

    it("audita la actualización y el borrado de una fuente", async () => {
      const created = await request(server)
        .post("/api/sources")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ name: "Disposable", kind: "mysql", environment: "staging" });
      expect(created.status).toBe(201);

      const patched = await request(server)
        .patch("/api/sources/src-001")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ name: "Customer PostgreSQL (audit)" });
      expect(patched.status).toBe(200);
      const updated = byAction("source_updated")[0];
      expect(updated.resourceId).toBe("src-001");
      expect(updated.metadata).toEqual({ fields: ["name"] });

      const deleted = await request(server)
        .delete(`/api/sources/${created.body.id}`)
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf);
      expect(deleted.status).toBe(204);
      const removed = byAction("source_deleted")[0];
      expect(removed.actorUserId).toBe("bootstrap-admin");
      expect(removed.resourceId).toBe(created.body.id);
      expect(removed.metadata).toEqual({});
    });
  });

  describe("horarios de escaneo", () => {
    it("audita creación, cambio de estado y reprogramación del horario", async () => {
      const created = await request(server)
        .put("/api/sources/src-004/schedule")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ enabled: true, intervalMinutes: 60 });
      expect(created.status).toBe(200);
      const createdEvent = byAction("schedule_created")[0];
      expect(createdEvent.resourceType).toBe("schedule");
      expect(createdEvent.resourceId).toBe("src-004");
      expect(createdEvent.metadata).toMatchObject({
        enabled: true,
        intervalMinutes: 60,
        previousEnabled: null,
        previousIntervalMinutes: null,
      });

      const disabled = await request(server)
        .put("/api/sources/src-004/schedule")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ enabled: false, intervalMinutes: 60 });
      expect(disabled.status).toBe(200);
      expect(byAction("schedule_disabled")[0].metadata).toMatchObject({
        enabled: false,
        previousEnabled: true,
      });

      const rescheduled = await request(server)
        .put("/api/sources/src-004/schedule")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ enabled: false, intervalMinutes: 120 });
      expect(rescheduled.status).toBe(200);
      expect(byAction("schedule_updated")[0].metadata).toMatchObject({
        enabled: false,
        intervalMinutes: 120,
        previousIntervalMinutes: 60,
      });
    });
  });

  describe("reglas, scans, informes y masking", () => {
    it("audita la activación y desactivación de una regla", async () => {
      const off = await request(server)
        .patch("/api/rules/rule-001")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ enabled: false });
      expect(off.status).toBe(200);
      const disabled = byAction("rule_disabled")[0];
      expect(disabled.resourceType).toBe("rule");
      expect(disabled.resourceId).toBe("rule-001");
      expect(disabled.metadata).toEqual({ enabled: false });

      const on = await request(server)
        .patch("/api/rules/rule-001")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ enabled: true });
      expect(on.status).toBe(200);
      expect(byAction("rule_enabled")[0].metadata).toEqual({ enabled: true });
    });

    it("audita el inicio y la cancelación de un escaneo", async () => {
      const started = await request(server)
        .post("/api/scans")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ sourceId: "src-002" });
      expect(started.status).toBe(202);

      const startEvent = byAction("scan_started")[0];
      expect(startEvent.actorUserId).toBe("bootstrap-admin");
      expect(startEvent.resourceType).toBe("scan");
      expect(startEvent.resourceId).toBe(started.body.id);
      expect(startEvent.metadata).toMatchObject({ sourceId: "src-002", trigger: "manual" });

      // Cancelación sobre un scan `running` sembrado (determinista).
      addRunningScan("scan-audit-cancel", "src-003");
      const cancelled = await request(server)
        .post("/api/scans/scan-audit-cancel/cancel")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf);
      expect(cancelled.status).toBe(202);
      const cancelEvent = byAction("scan_cancelled")[0];
      expect(cancelEvent.actorUserId).toBe("bootstrap-admin");
      expect(cancelEvent.resourceId).toBe("scan-audit-cancel");
      expect(cancelEvent.metadata).toMatchObject({ sourceId: "src-003" });
    });
  });

  describe("informes y datasets", () => {
    it("audita la generación y la descarga de un informe", async () => {
      const created = await request(server)
        .post("/api/reports")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ name: "Auditoría M17", period: "last_30d" });
      expect(created.status).toBe(201);
      const createdEvent = byAction("report_created")[0];
      expect(createdEvent.resourceType).toBe("report");
      expect(createdEvent.resourceId).toBe(created.body.id);
      // Se audita el periodo, no el nombre (texto libre del usuario).
      expect(createdEvent.metadata).toEqual({ period: "last_30d" });

      const download = await request(server)
        .get(`/api/reports/${created.body.id}/download`)
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie);
      expect(download.status).toBe(200);
      const downloadEvent = byAction("report_downloaded")[0];
      expect(downloadEvent.actorUserId).toBe("bootstrap-admin");
      expect(downloadEvent.resourceId).toBe(created.body.id);
    });

    it("audita la creación del job de masking y la descarga del dataset", async () => {
      const source = state().sources.find((s) => s.id === "src-001");
      if (!source) throw new Error("fixture src-001 missing");
      const original = source.connectionConfig;
      source.connectionConfig = MOCK_CONFIG;
      try {
        const created = await request(server)
          .post("/api/masking/jobs")
          .set("X-Forwarded-For", nextIp())
          .set("Cookie", adminCookie)
          .set("X-CSRF-Token", adminCsrf)
          .send({ sourceId: "src-001", fields: ["email"] });
        expect(created.status).toBe(201);
        const createdEvent = byAction("masking_job_created")[0];
        expect(createdEvent.resourceType).toBe("masking_job");
        expect(createdEvent.resourceId).toBe(created.body.id);
        expect(createdEvent.metadata).toMatchObject({
          sourceId: "src-001",
          fields: ["email"],
          status: "ready",
        });

        const download = await request(server)
          .get(`/api/masking/jobs/${created.body.id}/download`)
          .set("X-Forwarded-For", nextIp())
          .set("Cookie", adminCookie);
        expect(download.status).toBe(200);
        const downloadEvent = byAction("dataset_downloaded")[0];
        expect(downloadEvent.actorUserId).toBe("bootstrap-admin");
        expect(downloadEvent.resourceId).toBe(created.body.id);
        expect(Number(downloadEvent.metadata.records)).toBeGreaterThan(0);
      } finally {
        source.connectionConfig = original;
      }
    });
  });

  describe("acciones internas (sin actor humano)", () => {
    it("audita el despacho del scheduler con actor null y origin scheduler", async () => {
      const claimDue = vi.spyOn(repos.scanSchedules, "claimDue").mockResolvedValue([
        {
          schedule: {
            id: "sched-audit-1",
            sourceId: "src-002",
            enabled: true,
            intervalMinutes: 60,
            nextRunAt: new Date(),
            lastRunAt: null,
            lastStatus: null,
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
      ] as never);
      const startScan = vi.spyOn(repos.scans, "startScanInternal").mockResolvedValue({
        ok: true,
        scan: { id: "scan-sched-audit" },
        sourceName: "Analytics Warehouse",
        sourceTables: 1,
      } as never);

      try {
        const summary = await runSchedulerTick(new Date());
        expect(summary.dispatched).toBe(1);

        const event = byAction("scan_started")[0];
        expect(event.actorUserId).toBeNull();
        expect(event.result).toBe("success");
        expect(event.requestId).toBeNull();
        expect(event.resourceId).toBe("scan-sched-audit");
        expect(event.metadata).toMatchObject({
          origin: "scheduler",
          sourceId: "src-002",
          scheduleId: "sched-audit-1",
          intervalMinutes: 60,
          trigger: "scheduler",
        });
      } finally {
        claimDue.mockRestore();
        startScan.mockRestore();
      }
    });

    it("audita el fallo de despacho sin filtrar el mensaje de error", async () => {
      const claimDue = vi.spyOn(repos.scanSchedules, "claimDue").mockResolvedValue([
        {
          schedule: {
            id: "sched-audit-2",
            sourceId: "src-002",
            enabled: true,
            intervalMinutes: 30,
            nextRunAt: new Date(),
            lastRunAt: null,
            lastStatus: null,
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
      ] as never);
      const startScan = vi
        .spyOn(repos.scans, "startScanInternal")
        .mockRejectedValue(
          new Error('connection to server failed: password "db-secret" rejected'),
        );

      try {
        const summary = await runSchedulerTick(new Date());
        expect(summary.failed).toBe(1);

        const event = byAction("scan_started")[0];
        expect(event.actorUserId).toBeNull();
        expect(event.result).toBe("failure");
        expect(event.resourceId).toBeNull();
        expect(event.metadata).toMatchObject({
          origin: "scheduler",
          scheduleId: "sched-audit-2",
          reason: "dispatch_error",
        });
        expect(JSON.stringify(event.metadata)).not.toContain("db-secret");
      } finally {
        claimDue.mockRestore();
        startScan.mockRestore();
      }
    });

    it("audita los scans recuperados por el reaper con origin recovery", async () => {
      const staleStartedAt = new Date(Date.now() - 60 * 60_000);
      state().scans.push({
        id: "scan-audit-stale",
        sourceId: "src-003",
        status: "running",
        startedAt: staleStartedAt,
        completedAt: null,
        findingsCreated: 0,
        heartbeatAt: staleStartedAt,
        tablesScanned: 0,
        recordsRead: 0,
        cancelRequested: false,
      });

      const recovered = await recoverOrphanedScansAtBoot(new Date());
      expect(recovered.map((scan) => scan.id)).toContain("scan-audit-stale");

      const event = byAction("scan_failed").find(
        (e) => e.resourceId === "scan-audit-stale",
      );
      expect(event).toBeDefined();
      expect(event?.actorUserId).toBeNull();
      expect(event?.result).toBe("failure");
      expect(event?.requestId).toBeNull();
      expect(event?.metadata).toMatchObject({
        origin: "recovery",
        sourceId: "src-003",
        reason: "timeout",
        sweep: "boot",
      });
    });
  });

  describe("saneado de metadata (defensa en profundidad)", () => {
    it("descarta claves sensibles por nombre y conserva las operativas", () => {
      const safe = sanitizeAuditMetadata({
        password: "p",
        newPassword: "p2",
        passwordHash: "h",
        token: "t",
        jwt: "j",
        cookie: "c",
        csrfToken: "x",
        authorization: "a",
        connection: { host: "db.internal" },
        connectionConfig: { password: "p" },
        apiKey: "k",
        encryptionKey: "k",
        privateKey: "k",
        salt: "s",
        sourceId: "src-001",
        revoked: 3,
      });
      expect(Object.keys(safe).sort()).toEqual(["revoked", "sourceId"]);
    });

    it("sustituye valores con forma de JWT y trunca cadenas largas", () => {
      const safe = sanitizeAuditMetadata({
        session: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop",
        long: "x".repeat(300),
      });
      expect(safe.session).toBe("[redacted]");
      expect(String(safe.long)).toHaveLength(257);
      expect(String(safe.long).endsWith("…")).toBe(true);
    });

    it("descarta objetos anidados, valores no finitos y undefined", () => {
      const safe = sanitizeAuditMetadata({
        nested: { a: 1 },
        mixed: ["a", { b: 1 }, 2],
        infinite: Number.POSITIVE_INFINITY,
        notANumber: Number.NaN,
        missing: undefined,
        nullValue: null,
        when: new Date("2024-01-02T03:04:05.000Z"),
      });
      expect(Object.keys(safe).sort()).toEqual([
        "mixed",
        "nullValue",
        "when",
      ]);
      expect(safe.mixed).toEqual(["a", 2]);
      expect(safe.nullValue).toBeNull();
      expect(safe.when).toBe("2024-01-02T03:04:05.000Z");
    });

    it("limita la cantidad de claves y nunca lanza con entradas raras", () => {
      const wide: Record<string, unknown> = {};
      for (let i = 0; i < 40; i += 1) wide[`k${i}`] = i;
      expect(Object.keys(sanitizeAuditMetadata(wide))).toHaveLength(32);
      expect(sanitizeAuditMetadata(undefined)).toEqual({});
    });
  });

  describe("GET /api/audit-events (solo admin)", () => {
    it("401 sin autenticación", async () => {
      const res = await request(server)
        .get("/api/audit-events")
        .set("X-Forwarded-For", nextIp());
      expect(res.status).toBe(401);
    });

    it("403 para un usuario con rol no autorizado (auditor)", async () => {
      const res = await request(server)
        .get("/api/audit-events")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", auditorCookie);
      expect(res.status).toBe(403);
      expect(res.body.status).toBe(403);
    });

    it("200 para admin: más recientes primero y shape del contrato", async () => {
      const res = await request(server)
        .get("/api/audit-events")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(5);

      const first = res.body[0] as Record<string, unknown>;
      expect(typeof first.id).toBe("string");
      expect(typeof first.action).toBe("string");
      expect(typeof first.resourceType).toBe("string");
      expect(["success", "failure"]).toContain(first.result);
      expect(Number.isNaN(Date.parse(String(first.createdAt)))).toBe(false);

      const timestamps = (res.body as { createdAt: string }[]).map((e) =>
        Date.parse(e.createdAt),
      );
      expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
    });

    it("filtra por action, actor, result y recurso", async () => {
      const byAction = await request(server)
        .get("/api/audit-events?action=source_created")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie);
      expect(byAction.status).toBe(200);
      expect(byAction.body.length).toBeGreaterThanOrEqual(1);
      expect(byAction.body.every((e: { action: string }) => e.action === "source_created")).toBe(true);

      const byActor = await request(server)
        .get("/api/audit-events?actor=bootstrap-admin")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie);
      expect(byActor.body.length).toBeGreaterThanOrEqual(1);
      expect(
        byActor.body.every((e: { actorUserId: string | null }) => e.actorUserId === "bootstrap-admin"),
      ).toBe(true);

      const byResult = await request(server)
        .get("/api/audit-events?result=failure")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie);
      expect(byResult.body.every((e: { result: string }) => e.result === "failure")).toBe(true);

      const byResource = await request(server)
        .get("/api/audit-events?resourceType=schedule&resourceId=src-004")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie);
      expect(byResource.body.length).toBeGreaterThanOrEqual(3);
      expect(
        byResource.body.every(
          (e: { resourceType: string; resourceId: string }) =>
            e.resourceType === "schedule" && e.resourceId === "src-004",
        ),
      ).toBe(true);
    });

    it("pagina con limit/offset y acepta un rango temporal válido", async () => {
      const first = await request(server)
        .get("/api/audit-events?limit=2")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie);
      expect(first.status).toBe(200);
      expect(first.body).toHaveLength(2);

      const second = await request(server)
        .get("/api/audit-events?limit=2&offset=2")
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie);
      expect(second.body).toHaveLength(2);
      expect(second.body[0].id).not.toBe(first.body[0].id);

      const from = new Date(Date.now() - 3_600_000).toISOString();
      const to = new Date(Date.now() + 60_000).toISOString();
      const ranged = await request(server)
        .get(`/api/audit-events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
        .set("X-Forwarded-For", nextIp())
        .set("Cookie", adminCookie);
      expect(ranged.status).toBe(200);
      expect(ranged.body.length).toBeGreaterThan(0);
    });

    it("400 en filtros inválidos (fecha, enum y paginación fuera de rango)", async () => {
      const invalid = [
        "/api/audit-events?from=not-a-date",
        "/api/audit-events?to=31%2F12%2F2024",
        "/api/audit-events?result=maybe",
        "/api/audit-events?limit=101",
        "/api/audit-events?limit=0",
        "/api/audit-events?offset=-1",
        "/api/audit-events?from=2024-02-02T00%3A00%3A00Z&to=2024-01-01T00%3A00%3A00Z",
      ];
      for (const path of invalid) {
        const res = await request(server)
          .get(path)
          .set("X-Forwarded-For", nextIp())
          .set("Cookie", adminCookie);
        expect(res.status, path).toBe(400);
      }
    });

    it("la auditoría es best-effort: si falla la escritura, la acción sigue OK", async () => {
      const create = vi
        .spyOn(repos.auditEvents, "create")
        .mockRejectedValue(new Error("audit table unavailable"));
      try {
        const res = await request(server)
          .post("/api/sources")
          .set("X-Forwarded-For", nextIp())
          .set("Cookie", adminCookie)
          .set("X-CSRF-Token", adminCsrf)
          .send({ name: "Best effort", kind: "mysql", environment: "staging" });
        expect(res.status).toBe(201);
      } finally {
        create.mockRestore();
      }
    });
  });
});