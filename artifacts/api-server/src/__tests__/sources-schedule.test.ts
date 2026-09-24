/**
 * M10.5 — Rutas de horario de escaneo automático (scheduled scans).
 *
 * Contrato verificado (OpenAPI M10.1):
 * - GET  /api/sources/:id/schedule → lectura para cualquier usuario
 *   autenticado; 404 si la fuente no existe; fuente sin fila de schedule →
 *   200 con default disabled (intervalMinutes 1440, nextRunAt null).
 * - PUT  /api/sources/:id/schedule → solo admin (403 auditor); enabled=true
 *   exige intervalMinutes en [15, 10080] (400 si falta o fuera de rango);
 *   fuente inexistente → 404; body inválido → 400; sin auth → 401.
 * - La ruta solo usa la capa `repos` (sin SQL directo) y el rechazo de RBAC
 *   ocurre ANTES de cualquier mutación (estado del mock intacto).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import type { MockState } from "./mock-repos";
import { repos } from "../repositories";
import { fetchCsrfToken, seedProvisionedAdmin, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "./test-utils";

process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.SOURCE_ENCRYPTION_KEY = "test-source-encryption-key-of-at-least-32-characters!!";
process.env.AUTH_REGISTRATION_ENABLED = "true";

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

let ipSeq = 0;
const nextIp = (): string => `10.90.1.${++ipSeq}`;

function cookieOf(res: { headers: { [k: string]: unknown } }): string {
  const set = res.headers["set-cookie"] as string[] | string | undefined;
  const arr = Array.isArray(set) ? set : set ? [set] : [];
  const hit = arr.find((c) => c.startsWith("session="));
  if (!hit) throw new Error("session cookie not found");
  return hit.split(";")[0];
}

const SCHEDULE_PATH = (id: string) => `/api/sources/${id}/schedule`;

describe("Sources schedule API (M10.5)", () => {
  let server: ReturnType<Express["listen"]>;
  let adminCookie: string;
  let auditorCookie: string;
  let adminCsrf: string;
  let auditorCsrf: string;

  beforeAll(async () => {
    server = app.listen(0);

    await seedProvisionedAdmin(state());
    const boot = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", nextIp())
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD });
    expect(boot.status).toBe(200);
    adminCookie = cookieOf(boot);
    adminCsrf = await fetchCsrfToken(server, adminCookie);

    const reg = await request(server)
      .post("/api/auth/register")
      .set("X-Forwarded-For", nextIp())
      .send({ email: "auditor-sched@example.com", password: "secure-password-123" });
    expect(reg.status).toBe(201);
    const login = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", nextIp())
      .send({ email: "auditor-sched@example.com", password: "secure-password-123" });
    expect(login.status).toBe(200);
    auditorCookie = cookieOf(login);
    auditorCsrf = await fetchCsrfToken(server, auditorCookie);
  });

  afterAll(() => {
    server.close();
  });

  it("401 sin cookie en ambas rutas de schedule", async () => {
    const get = await request(server).get(SCHEDULE_PATH("src-001"));
    const put = await request(server).put(SCHEDULE_PATH("src-001")).send({ enabled: true, intervalMinutes: 60 });
    expect(get.status).toBe(401);
    expect(put.status).toBe(401);
  });

  describe("GET /api/sources/:id/schedule", () => {
    it("200 con el schedule existente de la fuente", async () => {
      const seeded = {
        id: "sched-seed-1",
        sourceId: "src-001",
        enabled: true,
        intervalMinutes: 360,
        nextRunAt: new Date("2026-02-01T10:00:00Z"),
        lastRunAt: new Date("2026-01-31T10:00:00Z"),
        lastStatus: "ok" as const,
        lastError: null,
        createdAt: new Date("2026-01-30T10:00:00Z"),
        updatedAt: new Date("2026-01-31T10:00:00Z"),
      };
      state().scanSchedules.push(seeded);

      const res = await request(server).get(SCHEDULE_PATH("src-001")).set("Cookie", adminCookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sourceId: "src-001",
        enabled: true,
        intervalMinutes: 360,
        nextRunAt: "2026-02-01T10:00:00.000Z",
        lastRunAt: "2026-01-31T10:00:00.000Z",
        lastStatus: "ok",
      });
    });

    it("200 con default disabled cuando la fuente existe pero no tiene schedule", async () => {
      const before = state().scanSchedules.length;
      const res = await request(server).get(SCHEDULE_PATH("src-002")).set("Cookie", adminCookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sourceId: "src-002",
        enabled: false,
        intervalMinutes: 1440,
        nextRunAt: null,
        lastRunAt: null,
        lastStatus: null,
      });
      // La lectura no crea fila: sigue siendo "sin schedule".
      expect(state().scanSchedules.length).toBe(before);
    });

    it("404 cuando la fuente no existe", async () => {
      const res = await request(server).get(SCHEDULE_PATH("src-404")).set("Cookie", adminCookie);
      expect(res.status).toBe(404);
    });

    it("invoca la capa repos (getBySourceId) sin acceso directo a DB", async () => {
      const spy = vi.spyOn(repos.scanSchedules, "getBySourceId");
      const res = await request(server).get(SCHEDULE_PATH("src-003")).set("Cookie", adminCookie);
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith("src-003", "org-bootstrap");
      spy.mockRestore();
    });
  });

  describe("PUT /api/sources/:id/schedule", () => {
    it("200 (admin) habilitando con intervalo válido: fila persistida y nextRunAt en el futuro", async () => {
      const before = state().scanSchedules.filter((s) => s.sourceId === "src-004").length;
      const at = Date.now();
      const res = await request(server)
        .put(SCHEDULE_PATH("src-004"))
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ enabled: true, intervalMinutes: 60 });
      expect(res.status).toBe(200);
      expect(res.body.sourceId).toBe("src-004");
      expect(res.body.enabled).toBe(true);
      expect(res.body.intervalMinutes).toBe(60);
      expect(res.body.lastStatus).toBeNull();

      const nextRunAt = Date.parse(res.body.nextRunAt);
      expect(Number.isNaN(nextRunAt)).toBe(false);
      expect(nextRunAt).toBeGreaterThanOrEqual(at + 60 * 60_000 - 1000);
      expect(nextRunAt).toBeLessThanOrEqual(at + 60 * 60_000 + 5000);

      const rows = state().scanSchedules.filter((s) => s.sourceId === "src-004");
      expect(rows).toHaveLength(Math.max(before, 0) + 1);
      expect(rows[0]?.enabled).toBe(true);
      expect(rows[0]?.intervalMinutes).toBe(60);
    });

    it("200 (admin) deshabilitando sin intervalo: default 1440 y nextRunAt null", async () => {
      const res = await request(server)
        .put(SCHEDULE_PATH("src-004"))
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ enabled: false });
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.intervalMinutes).toBe(1440);
      expect(res.body.nextRunAt).toBeNull();

      const row = state().scanSchedules.find((s) => s.sourceId === "src-004");
      expect(row?.enabled).toBe(false);
      expect(row?.nextRunAt).toBeNull();
    });

    it("200 (admin) deshabilitando con intervalo explícito válido", async () => {
      const res = await request(server)
        .put(SCHEDULE_PATH("src-004"))
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ enabled: false, intervalMinutes: 15 });
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.intervalMinutes).toBe(15);
      expect(res.body.nextRunAt).toBeNull();
    });

    it("400 con intervalo menor que 15", async () => {
      const before = state().scanSchedules.length;
      const res = await request(server)
        .put(SCHEDULE_PATH("src-004"))
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ enabled: true, intervalMinutes: 14 });
      expect(res.status).toBe(400);
      expect(state().scanSchedules.length).toBe(before);
    });

    it("400 con intervalo mayor que 10080", async () => {
      const before = state().scanSchedules.length;
      const res = await request(server)
        .put(SCHEDULE_PATH("src-004"))
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ enabled: true, intervalMinutes: 10081 });
      expect(res.status).toBe(400);
      expect(state().scanSchedules.length).toBe(before);
    });

    it("400 con enabled=true sin intervalMinutes", async () => {
      const before = state().scanSchedules.length;
      const res = await request(server)
        .put(SCHEDULE_PATH("src-004"))
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ enabled: true });
      expect(res.status).toBe(400);
      expect(state().scanSchedules.length).toBe(before);
    });

    it("400 con payload inválido (enabled no booleano)", async () => {
      const before = state().scanSchedules.length;
      const res = await request(server)
        .put(SCHEDULE_PATH("src-004"))
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ enabled: "yes", intervalMinutes: 60 });
      expect(res.status).toBe(400);
      expect(state().scanSchedules.length).toBe(before);
    });

    it("403 para auditor sin mutar estado", async () => {
      const before = state().scanSchedules.length;
      const res = await request(server)
        .put(SCHEDULE_PATH("src-004"))
        .set("Cookie", auditorCookie)
        .set("X-CSRF-Token", auditorCsrf)
        .send({ enabled: true, intervalMinutes: 60 });
      expect(res.status).toBe(403);
      expect(state().scanSchedules.length).toBe(before);
    });

    it("404 cuando la fuente no existe (el repo reporta source_not_found)", async () => {
      const res = await request(server)
        .put(SCHEDULE_PATH("src-404"))
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ enabled: true, intervalMinutes: 60 });
      expect(res.status).toBe(404);
      expect(state().scanSchedules.find((s) => s.sourceId === "src-404")).toBeUndefined();
    });

    it("invoca la capa repos (upsert) sin acceso directo a DB", async () => {
      const spy = vi.spyOn(repos.scanSchedules, "upsert");
      const res = await request(server)
        .put(SCHEDULE_PATH("src-001"))
        .set("Cookie", adminCookie)
        .set("X-CSRF-Token", adminCsrf)
        .send({ enabled: true, intervalMinutes: 30 });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]?.sourceId).toBe("src-001");
      expect(spy.mock.calls[0]?.[0]?.enabled).toBe(true);
      expect(spy.mock.calls[0]?.[0]?.intervalMinutes).toBe(30);
      spy.mockRestore();
    });
  });
});