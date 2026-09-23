/**
 * FASE 7.1.2 (M2) — Cancelación cooperativa: POST /api/scans/:id/cancel.
 *
 * Contrato verificado:
 * - Solo admin: 401 anónimo, 403 auditor. El rechazo NO marca el flag.
 * - 202 sobre scan `running` con el Scan público (D4: SIN cancelRequested) y
 *   el flag persistido en el estado (`cancelRequested: true`); el status
 *   SIGUE `running` (la terminación la hace el scanner de forma cooperativa).
 * - Idempotente: doble cancelación mientras sigue `running` → 202 de nuevo.
 * - 404 inexistente · 409 scan ya terminal (completed / failed).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import type { MockState } from "./mock-repos";
import { fetchCsrfToken } from "./test-utils";

process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.SOURCE_ENCRYPTION_KEY = "test-source-encryption-key-of-at-least-32-characters!!";
process.env.AUTH_BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-only";
process.env.AUTH_BOOTSTRAP_ENABLED = "true";
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
const nextIp = (): string => `10.92.0.${++ipSeq}`;

function cookieOf(res: { headers: { [k: string]: unknown } }): string {
  const set = res.headers["set-cookie"] as string[] | string | undefined;
  const arr = Array.isArray(set) ? set : set ? [set] : [];
  const hit = arr.find((c) => c.startsWith("session="));
  if (!hit) throw new Error("session cookie not found");
  return hit.split(";")[0];
}

function addScan(id: string, status: string): void {
  // M21.5 — el scan referencia una source existente con tenant conocido.
  if (!state().sources.some((s) => s.id === "src-cancel-target")) {
    state().sources.push({
      id: "src-cancel-target",
      name: "src-cancel-target",
      kind: "postgresql",
      environment: "production",
      status: "healthy",
      lastScanAt: null,
      tables: 0,
      records: 0,
      connectionConfig: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      findingsCount: 0,
      tenantId: "org-bootstrap",
    });
  }
  state().scans.push({
    id,
    sourceId: "src-cancel-target",
    status,
    startedAt: new Date(),
    completedAt: status === "running" ? null : new Date(),
    findingsCreated: 0,
    heartbeatAt: null,
    tablesScanned: 0,
    recordsRead: 0,
    cancelRequested: false,
  });
}

describe("Scans cancel (FASE 7.1.2 M2)", () => {
  let server: ReturnType<Express["listen"]>;
  let adminCookie: string;
  let auditorCookie: string;
  let adminCsrf: string;
  let auditorCsrf: string;

  beforeAll(async () => {
    server = app.listen(0);

    const boot = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", nextIp())
      .send({ token: "bootstrap-token-for-tests-only" });
    expect(boot.status).toBe(200);
    adminCookie = cookieOf(boot);
    adminCsrf = await fetchCsrfToken(server, adminCookie);

    const reg = await request(server)
      .post("/api/auth/register")
      .set("X-Forwarded-For", nextIp())
      .send({ email: "auditor-cancel@example.com", password: "secure-password-123" });
    expect(reg.status).toBe(201);
    const login = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", nextIp())
      .send({ email: "auditor-cancel@example.com", password: "secure-password-123" });
    expect(login.status).toBe(200);
    auditorCookie = cookieOf(login);
    auditorCsrf = await fetchCsrfToken(server, auditorCookie);
  });

  afterAll(() => {
    server.close();
  });

  it("401 anónimo", async () => {
    const res = await request(server).post("/api/scans/scan-cancel-1/cancel");
    expect(res.status).toBe(401);
  });

  it("403 auditor y el flag NO se marca", async () => {
    addScan("scan-cancel-1", "running");
    const res = await request(server)
      .post("/api/scans/scan-cancel-1/cancel")
      .set("Cookie", auditorCookie)
      .set("X-CSRF-Token", auditorCsrf);
    expect(res.status).toBe(403);
    expect(state().scans.find((item) => item.id === "scan-cancel-1")?.cancelRequested).toBe(false);
  });

  it("202 admin sobre running: flag marcado, status sigue running y SIN cancelRequested (D4)", async () => {
    const res = await request(server)
      .post("/api/scans/scan-cancel-1/cancel")
      .set("Cookie", adminCookie)
      .set("X-CSRF-Token", adminCsrf);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id: "scan-cancel-1", status: "running" });
    // D4: el contrato Scan público NO expone el flag interno.
    expect(res.body.cancelRequested).toBeUndefined();
    // Cooperativa: el endpoint NO cambia el status; el scanner lo cerrará.
    const scan = state().scans.find((item) => item.id === "scan-cancel-1");
    expect(scan?.status).toBe("running");
    expect(scan?.cancelRequested).toBe(true);
  });

  it("202 idempotente en doble cancelación mientras sigue running", async () => {
    const res = await request(server)
      .post("/api/scans/scan-cancel-1/cancel")
      .set("Cookie", adminCookie)
      .set("X-CSRF-Token", adminCsrf);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id: "scan-cancel-1", status: "running" });
  });

  it("404 scan inexistente", async () => {
    const res = await request(server)
      .post("/api/scans/scan-ghost/cancel")
      .set("Cookie", adminCookie)
      .set("X-CSRF-Token", adminCsrf);
    expect(res.status).toBe(404);
    expect(res.body.title).toBe("Not Found");
  });

  it("409 scan ya terminal (completed y failed)", async () => {
    addScan("scan-cancel-done", "completed");
    addScan("scan-cancel-fail", "failed");
    const done = await request(server)
      .post("/api/scans/scan-cancel-done/cancel")
      .set("Cookie", adminCookie)
      .set("X-CSRF-Token", adminCsrf);
    expect(done.status).toBe(409);
    expect(done.body.title).toBe("Conflict");
    const failed = await request(server)
      .post("/api/scans/scan-cancel-fail/cancel")
      .set("Cookie", adminCookie)
      .set("X-CSRF-Token", adminCsrf);
    expect(failed.status).toBe(409);
    // El flag de un scan terminal nunca se marca vía endpoint.
    expect(state().scans.find((item) => item.id === "scan-cancel-done")?.cancelRequested).toBe(false);
    expect(state().scans.find((item) => item.id === "scan-cancel-fail")?.cancelRequested).toBe(false);
  });
});