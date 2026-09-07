/**
 * FASE 7.0.0 — CRUD de fuentes de datos (HTTP + RBAC).
 *
 * Contrato verificado:
 * - POST/PATCH/DELETE /api/sources* exigen rol `admin` (403 si auditor), y el
 *   rechazo ocurre ANTES de cualquier mutación (estado del mock intacto).
 * - GET /api/sources/:id es lectura para cualquier usuario autenticado.
 * - La contraseña es WRITE-ONLY: se acepta en el body pero NUNCA aparece en la
 *   respuesta (SourceDetail no incluye connection).
 * - Id inexistente → 404; body inválido → 400; sin auth → 401.
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
const nextIp = (): string => `10.90.0.${++ipSeq}`;

function cookieOf(res: { headers: { [k: string]: unknown } }): string {
  const set = res.headers["set-cookie"] as string[] | string | undefined;
  const arr = Array.isArray(set) ? set : set ? [set] : [];
  const hit = arr.find((c) => c.startsWith("session="));
  if (!hit) throw new Error("session cookie not found");
  return hit.split(";")[0];
}

const validBody = {
  name: "Postgres Producción",
  kind: "postgresql",
  environment: "production",
  connection: {
    host: "db.internal.example.com",
    port: 5432,
    database: "app",
    user: "scanner",
    password: "super-secret-password-123",
    schema: "public",
  },
};
describe("Sources CRUD (FASE 7.0.0)", () => {
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
      .send({ email: "auditor-src@example.com", password: "secure-password-123" });
    expect(reg.status).toBe(201);
    const login = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", nextIp())
      .send({ email: "auditor-src@example.com", password: "secure-password-123" });
    expect(login.status).toBe(200);
    auditorCookie = cookieOf(login);
  });

  afterAll(() => {
    server.close();
  });

  it("401 sin cookie en todas las rutas de sources", async () => {
    const get = await request(server).get("/api/sources/src-001");
    const post = await request(server).post("/api/sources").send(validBody);
    expect(get.status).toBe(401);
    expect(post.status).toBe(401);
  });

  it("POST /api/sources (admin) → 201, sin password en respuesta, scannable=true", async () => {
    const before = state().sources.length;
    const res = await request(server)
      .post("/api/sources")
      .set("Cookie", adminCookie)
      .send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe("Postgres Producción");
    expect(res.body.kind).toBe("postgresql");
    expect(res.body.scannable).toBe(true);
    // WRITE-ONLY: el password nunca viaja en la respuesta.
    expect(JSON.stringify(res.body)).not.toContain("super-secret-password-123");
    expect("connection" in res.body).toBe(false);
    expect(state().sources.length).toBe(before + 1);
  });

  it("POST /api/sources (auditor) → 403 sin crear", async () => {
    const before = state().sources.length;
    const res = await request(server)
      .post("/api/sources")
      .set("Cookie", auditorCookie)
      .send(validBody);
    expect(res.status).toBe(403);
    expect(state().sources.length).toBe(before);
  });

  it("POST /api/sources sin connection → 201, scannable=false (legacy/placeholder)", async () => {
    const before = state().sources.length;
    const res = await request(server)
      .post("/api/sources")
      .set("Cookie", adminCookie)
      .send({ name: "Source Placeholder", kind: "postgresql", environment: "development" });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Source Placeholder");
    expect(res.body.scannable).toBe(false);
    const created = state().sources.find((s) => s.name === "Source Placeholder");
    expect(created?.connectionConfig).toBeNull();
    expect(state().sources.length).toBe(before + 1);
  });

  it("POST /api/sources body inválido → 400", async () => {
    const before = state().sources.length;
    const res = await request(server)
      .post("/api/sources")
      .set("Cookie", adminCookie)
      .send({ name: "X", kind: "postgresql" }); // falta environment
    expect(res.status).toBe(400);
    expect(state().sources.length).toBe(before);
  });

  it("GET /api/sources/:id → 200 para auditor (lectura sin admin)", async () => {
    const res = await request(server)
      .get("/api/sources/src-001")
      .set("Cookie", auditorCookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("src-001");
    expect("connection" in res.body).toBe(false);
  });

  it("GET /api/sources/:id inexistente → 404", async () => {
    const res = await request(server)
      .get("/api/sources/nope")
      .set("Cookie", adminCookie);
    expect(res.status).toBe(404);
  });

  it("PATCH /api/sources/:id (admin) → 200 renombra sin romper credenciales", async () => {
    const res = await request(server)
      .patch("/api/sources/src-002")
      .set("Cookie", adminCookie)
      .send({ name: "Warehouse Renombrado" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Warehouse Renombrado");
    expect(res.body.id).toBe("src-002");
    const row = state().sources.find((s) => s.id === "src-002");
    expect(row?.name).toBe("Warehouse Renombrado");
  });

  it("PATCH /api/sources/:id (auditor) → 403 sin mutar", async () => {
    const beforeName = state().sources.find((s) => s.id === "src-003")?.name;
    const res = await request(server)
      .patch("/api/sources/src-003")
      .set("Cookie", auditorCookie)
      .send({ name: "Hacked" });
    expect(res.status).toBe(403);
    expect(state().sources.find((s) => s.id === "src-003")?.name).toBe(beforeName);
  });

  it("DELETE /api/sources/:id (admin) → 204 y elimina", async () => {
    const before = state().sources.length;
    const res = await request(server)
      .delete("/api/sources/src-004")
      .set("Cookie", adminCookie);
    expect(res.status).toBe(204);
    expect(state().sources.length).toBe(before - 1);
    expect(state().sources.some((s) => s.id === "src-004")).toBe(false);
  });

  it("DELETE /api/sources/:id (auditor) → 403 sin eliminar", async () => {
    const before = state().sources.length;
    const res = await request(server)
      .delete("/api/sources/src-001")
      .set("Cookie", auditorCookie);
    expect(res.status).toBe(403);
    expect(state().sources.length).toBe(before);
    expect(state().sources.some((s) => s.id === "src-001")).toBe(true);
  });
});