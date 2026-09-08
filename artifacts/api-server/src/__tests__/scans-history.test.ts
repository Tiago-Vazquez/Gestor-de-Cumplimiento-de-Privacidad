/**
 * FASE 7.1.1 (M1) — Historial de scans: GET /api/scans y GET /api/scans/:id.
 *
 * Contrato verificado:
 * - Listado y detalle son LECTURA para cualquier usuario autenticado (401 sin
 *   cookie; 200 para auditor y admin). Ninguno exige rol admin.
 * - Orden newest-first (`startedAt DESC, id DESC` — decisión D2), consistente
 *   entre repo real y mock.
 * - Filtros exactos `sourceId` y `status`; `status=queued` es válido por el
 *   enum del contrato pero nunca devuelve resultados (no hay scans queued).
 * - Paginación offset/limit con límites estrictos (1..100, offset >= 0) → 400
 *   fuera de rango, sin clamp silencioso.
 * - El detalle expone el progreso del último latido (`tablesScanned`,
 *   `recordsRead`) añadido al contrato `Scan` en esta subfase.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import type { MockState } from "./mock-repos";

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
const nextIp = (): string => `10.91.0.${++ipSeq}`;

function cookieOf(res: { headers: { [k: string]: unknown } }): string {
  const set = res.headers["set-cookie"] as string[] | string | undefined;
  const arr = Array.isArray(set) ? set : set ? [set] : [];
  const hit = arr.find((c) => c.startsWith("session="));
  if (!hit) throw new Error("session cookie not found");
  return hit.split(";")[0];
}

// Reloj base fijo: los offsets en minutos dan orden determinista.
const t0 = new Date("2026-01-01T12:00:00.000Z");
const at = (minutes: number): Date => new Date(t0.getTime() + minutes * 60_000);

function addScan(input: {
  id: string;
  sourceId?: string;
  status?: string;
  startedAt: Date;
  completedAt?: Date | null;
  findingsCreated?: number;
  tablesScanned?: number;
  recordsRead?: number;
}): void {
  state().scans.push({
    id: input.id,
    sourceId: input.sourceId ?? "src-001",
    status: input.status ?? "completed",
    startedAt: input.startedAt,
    completedAt: input.completedAt ?? null,
    findingsCreated: input.findingsCreated ?? 0,
    heartbeatAt: null,
    tablesScanned: input.tablesScanned ?? 0,
    recordsRead: input.recordsRead ?? 0,
    cancelRequested: false,
  });
}

describe("Scans history (FASE 7.1.1 M1)", () => {
  let server: ReturnType<Express["listen"]>;
  let adminCookie: string;
  let auditorCookie: string;

  beforeAll(async () => {
    server = app.listen(0);

    const boot = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", nextIp())
      .send({ token: "bootstrap-token-for-tests-only" });
    expect(boot.status).toBe(200);
    adminCookie = cookieOf(boot);

    const reg = await request(server)
      .post("/api/auth/register")
      .set("X-Forwarded-For", nextIp())
      .send({ email: "auditor-scans@example.com", password: "secure-password-123" });
    expect(reg.status).toBe(201);
    const login = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", nextIp())
      .send({ email: "auditor-scans@example.com", password: "secure-password-123" });
    expect(login.status).toBe(200);
    auditorCookie = cookieOf(login);
  });

  afterAll(() => {
    server.close();
  });

  it("401 sin cookie en listado y detalle", async () => {
    const list = await request(server).get("/api/scans");
    const detail = await request(server).get("/api/scans/scan-x");
    expect(list.status).toBe(401);
    expect(detail.status).toBe(401);
  });

  it("200 con historial newest-first y progreso en cada item", async () => {
    addScan({ id: "scan-h-old", startedAt: at(0), tablesScanned: 1, recordsRead: 10 });
    addScan({ id: "scan-h-mid", startedAt: at(10), tablesScanned: 2, recordsRead: 20 });
    addScan({ id: "scan-h-new", startedAt: at(20), tablesScanned: 3, recordsRead: 30 });

    const res = await request(server).get("/api/scans").set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.map((scan: { id: string }) => scan.id)).toEqual([
      "scan-h-new",
      "scan-h-mid",
      "scan-h-old",
    ]);
    for (const scan of res.body) {
      expect(scan).toHaveProperty("tablesScanned");
      expect(scan).toHaveProperty("recordsRead");
      expect(scan).toHaveProperty("findingsCreated");
    }
    expect(res.body[0].tablesScanned).toBe(3);
    expect(res.body[0].recordsRead).toBe(30);
  });

  it("filtra por sourceId", async () => {
    addScan({ id: "scan-fa-early", sourceId: "src-filter-a", startedAt: at(0) });
    addScan({ id: "scan-fb", sourceId: "src-filter-b", startedAt: at(5) });
    addScan({ id: "scan-fa-late", sourceId: "src-filter-a", startedAt: at(15) });

    const res = await request(server)
      .get("/api/scans?sourceId=src-filter-a")
      .set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.map((scan: { id: string }) => scan.id)).toEqual([
      "scan-fa-late",
      "scan-fa-early",
    ]);
  });

  it("filtra por status=running", async () => {
    addScan({ id: "scan-s-run", sourceId: "src-status", status: "running", startedAt: at(2) });
    addScan({ id: "scan-s-done", sourceId: "src-status", status: "completed", startedAt: at(1) });
    addScan({ id: "scan-s-fail", sourceId: "src-status", status: "failed", startedAt: at(0) });

    const res = await request(server)
      .get("/api/scans?sourceId=src-status&status=running")
      .set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.map((scan: { id: string }) => scan.id)).toEqual(["scan-s-run"]);
  });

  it("status=queued es aceptado por el contrato pero nunca devuelve resultados", async () => {
    const res = await request(server)
      .get("/api/scans?status=queued")
      .set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("status fuera del enum → 400", async () => {
    const res = await request(server)
      .get("/api/scans?status=cancelled")
      .set("Cookie", adminCookie);
    expect(res.status).toBe(400);
  });

  it("paginación: limit=1&offset=1 devuelve el segundo más reciente", async () => {
    addScan({ id: "scan-p-old", sourceId: "src-page", startedAt: at(0) });
    addScan({ id: "scan-p-mid", sourceId: "src-page", startedAt: at(10) });
    addScan({ id: "scan-p-new", sourceId: "src-page", startedAt: at(20) });

    const res = await request(server)
      .get("/api/scans?sourceId=src-page&limit=1&offset=1")
      .set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.map((scan: { id: string }) => scan.id)).toEqual(["scan-p-mid"]);
  });

  it("400 en paginación fuera de rango (limit=0, limit=101, offset=-1)", async () => {
    for (const query of ["limit=0", "limit=101", "offset=-1"]) {
      const res = await request(server).get(`/api/scans?${query}`).set("Cookie", adminCookie);
      expect(res.status).toBe(400);
    }
  });

  it("tiebreak: startedAt idéntico se ordena por id DESC", async () => {
    addScan({ id: "scan-t1", sourceId: "src-tie", startedAt: at(30) });
    addScan({ id: "scan-t2", sourceId: "src-tie", startedAt: at(30) });

    const res = await request(server)
      .get("/api/scans?sourceId=src-tie")
      .set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.map((scan: { id: string }) => scan.id)).toEqual(["scan-t2", "scan-t1"]);
  });

  it("GET /api/scans/:id existente → 200 con shape completo (D1)", async () => {
    addScan({
      id: "scan-det",
      sourceId: "src-det",
      status: "completed",
      startedAt: at(40),
      completedAt: at(41),
      findingsCreated: 4,
      tablesScanned: 7,
      recordsRead: 1234,
    });

    const res = await request(server).get("/api/scans/scan-det").set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "scan-det",
      sourceId: "src-det",
      status: "completed",
      findingsCreated: 4,
      tablesScanned: 7,
      recordsRead: 1234,
    });
    expect(typeof res.body.startedAt).toBe("string");
    expect(typeof res.body.completedAt).toBe("string");
  });

  it("GET /api/scans/:id inexistente → 404", async () => {
    const res = await request(server).get("/api/scans/scan-ghost").set("Cookie", adminCookie);
    expect(res.status).toBe(404);
    expect(res.body.title).toBe("Not Found");
  });

  it("el auditor puede leer listado y detalle (200)", async () => {
    const list = await request(server).get("/api/scans").set("Cookie", auditorCookie);
    const detail = await request(server).get("/api/scans/scan-det").set("Cookie", auditorCookie);
    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
  });
});