/**
 * M11.1 — Protección CSRF por synchronizer token ligado a la sesión.
 *
 * Contrato verificado:
 * - GET /api/csrf-token: exige autenticación, devuelve SOLO el token de la
 *   sesión actual, estable (segunda llamada → mismo token), nunca crea sesión
 *   para usuarios no autenticados y no filtra datos de sesión.
 * - Mutaciones autenticadas por cookie (POST/PUT/PATCH/DELETE) exigen el
 *   header `X-CSRF-Token`; ausente/incorrecto/manipulado → 403 y la mutación
 *   NO llega a ejecutarse.
 * - Aislamiento entre sesiones: token A + sesión B → rechazado (y viceversa).
 * - Logout invalida el token; un login posterior crea uno nuevo distinto.
 * - GET/HEAD/OPTIONS nunca se bloquean por CSRF.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { decodeJwt } from "jose";
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
const nextIp = (): string => `10.70.0.${++ipSeq}`;

function cookieOf(res: { headers: { [k: string]: unknown } }): string {
  const set = res.headers["set-cookie"] as string[] | string | undefined;
  const arr = Array.isArray(set) ? set : set ? [set] : [];
  const hit = arr.find((c) => c.startsWith("session="));
  if (!hit) throw new Error("session cookie not found");
  return hit.split(";")[0];
}

async function loginBootstrap(
  server: ReturnType<Express["listen"]>,
  ip: string,
): Promise<{ cookie: string; csrf: string }> {
  const boot = await request(server)
    .post("/api/auth/login")
    .set("X-Forwarded-For", ip)
    .send({ token: "bootstrap-token-for-tests-only" });
  expect(boot.status).toBe(200);
  const cookie = cookieOf(boot);

  const csrfRes = await request(server).get("/api/csrf-token").set("Cookie", cookie);
  expect(csrfRes.status).toBe(200);
  return { cookie, csrf: csrfRes.body.csrfToken as string };
}

const validSourceBody = {
  name: "Postgres CSRF",
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

describe("M11.1 — CSRF synchronizer token (sesión única)", () => {
  let server: ReturnType<Express["listen"]>;
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    server = app.listen(0);
    const session = await loginBootstrap(server, nextIp());
    cookie = session.cookie;
    csrf = session.csrf;
  });

  afterAll(() => {
    server.close();
  });

  it("GET /api/csrf-token sin autenticación → 401", async () => {
    const res = await request(server).get("/api/csrf-token");
    expect(res.status).toBe(401);
  });

  it("GET /api/csrf-token devuelve SOLO el token (sin datos de sesión)", async () => {
    const res = await request(server).get("/api/csrf-token").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(typeof res.body.csrfToken).toBe("string");
    expect(res.body.csrfToken.length).toBeGreaterThan(0);
    // Únicamente el token necesario: ni sub, ni roles, ni jti, ni email.
    expect(Object.keys(res.body)).toEqual(["csrfToken"]);
  });

  it("segunda llamada de la misma sesión devuelve EL MISMO token (no se regenera)", async () => {
    const first = await request(server).get("/api/csrf-token").set("Cookie", cookie);
    const second = await request(server).get("/api/csrf-token").set("Cookie", cookie);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.csrfToken).toBe(first.body.csrfToken);
  });

  it("el JWT de sesión del login lleva el claim csrf firmado", async () => {
    const jwt = cookie.split("session=")[1];
    const payload = decodeJwt(jwt);
    expect(typeof payload.csrf).toBe("string");
    expect((payload.csrf as string).length).toBeGreaterThan(0);
  });

  it("POST /api/sources sin X-CSRF-Token → 403 y no muta", async () => {
    const before = state().sources.length;
    const res = await request(server)
      .post("/api/sources")
      .set("Cookie", cookie)
      .send(validSourceBody);
    expect(res.status).toBe(403);
    expect(state().sources.length).toBe(before);
  });

  it("PUT /api/sources/:id/schedule sin X-CSRF-Token → 403 y no muta", async () => {
    const before = state().scanSchedules.filter((s) => s.sourceId === "src-001").length;
    const res = await request(server)
      .put("/api/sources/src-001/schedule")
      .set("Cookie", cookie)
      .send({ enabled: true, intervalMinutes: 60 });
    expect(res.status).toBe(403);
    expect(state().scanSchedules.filter((s) => s.sourceId === "src-001")).toHaveLength(before);
  });

  it("PATCH /api/sources/:id sin X-CSRF-Token → 403 y no muta", async () => {
    const beforeName = state().sources.find((s) => s.id === "src-002")?.name;
    const res = await request(server)
      .patch("/api/sources/src-002")
      .set("Cookie", cookie)
      .send({ name: "Hacked" });
    expect(res.status).toBe(403);
    expect(state().sources.find((s) => s.id === "src-002")?.name).toBe(beforeName);
  });

  it("DELETE /api/sources/:id sin X-CSRF-Token → 403 y no elimina", async () => {
    const before = state().sources.length;
    const res = await request(server)
      .delete("/api/sources/src-004")
      .set("Cookie", cookie);
    expect(res.status).toBe(403);
    expect(state().sources).toHaveLength(before);
  });

  it("token incorrecto → 403", async () => {
    const res = await request(server)
      .post("/api/sources")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", "not-the-right-token")
      .send(validSourceBody);
    expect(res.status).toBe(403);
  });

  it("token manipulado (token real + sufijo) → 403", async () => {
    const res = await request(server)
      .post("/api/sources")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", `${csrf}extra`)
      .send(validSourceBody);
    expect(res.status).toBe(403);
  });

  it("token correcto de la sesión actual → 201 (mutación permitida)", async () => {
    const before = state().sources.length;
    const res = await request(server)
      .post("/api/sources")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrf)
      .send(validSourceBody);
    expect(res.status).toBe(201);
    expect(state().sources.length).toBe(before + 1);
  });

  it("GET sin token CSRF → 200 (no bloqueado)", async () => {
    const res = await request(server)
      .get("/api/sources/src-001")
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
  });

  it("HEAD sin token CSRF → no bloqueado por CSRF", async () => {
    const res = await request(server)
      .head("/api/sources/src-001")
      .set("Cookie", cookie);
    // 200 pero NUNCA 403 por CSRF.
    expect(res.status).not.toBe(403);
  });

  it("OPTIONS / preflight sin token CSRF → no bloqueado por CSRF", async () => {
    const res = await request(server)
      .options("/api/sources")
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "POST");
    // 204/200 del preflight CORS, nunca 403 por CSRF.
    expect(res.status).not.toBe(403);
  });
});

describe("M11.1 — Aislamiento entre sesiones (dos sesiones reales)", () => {
  let server: ReturnType<Express["listen"]>;
  let sessionA: { cookie: string; csrf: string };
  let sessionB: { cookie: string; csrf: string };

  beforeAll(async () => {
    server = app.listen(0);
    // DOS sesiones reales e independientes: dos bootstrap logins → dos JWT con
    // jti y claims csrf distintos (no es un mock de sesión única compartida).
    sessionA = await loginBootstrap(server, nextIp());
    sessionB = await loginBootstrap(server, nextIp());
    expect(sessionA.csrf).not.toBe(sessionB.csrf);
    expect(sessionA.cookie).not.toBe(sessionB.cookie);
  });

  afterAll(() => {
    server.close();
  });

  it("token A + sesión A → permitido", async () => {
    const res = await request(server)
      .post("/api/sources")
      .set("Cookie", sessionA.cookie)
      .set("X-CSRF-Token", sessionA.csrf)
      .send(validSourceBody);
    expect(res.status).toBe(201);
  });

  it("token B + sesión B → permitido", async () => {
    const res = await request(server)
      .post("/api/sources")
      .set("Cookie", sessionB.cookie)
      .set("X-CSRF-Token", sessionB.csrf)
      .send(validSourceBody);
    expect(res.status).toBe(201);
  });

  it("token A + sesión B → rechazado (403)", async () => {
    const res = await request(server)
      .post("/api/sources")
      .set("Cookie", sessionB.cookie)
      .set("X-CSRF-Token", sessionA.csrf)
      .send(validSourceBody);
    expect(res.status).toBe(403);
  });

  it("token B + sesión A → rechazado (403)", async () => {
    const res = await request(server)
      .post("/api/sources")
      .set("Cookie", sessionA.cookie)
      .set("X-CSRF-Token", sessionB.csrf)
      .send(validSourceBody);
    expect(res.status).toBe(403);
  });
});

describe("M11.1 — Logout invalida el token / nuevo login emite otro distinto", () => {
  let server: ReturnType<Express["listen"]>;

  beforeAll(() => {
    server = app.listen(0);
  });

  afterAll(() => {
    server.close();
  });

  it("token de una sesión logout-ed no vuelve a ser válido y el nuevo login emite otro token", async () => {
    const a = await loginBootstrap(server, nextIp());
    const tokenATrash = a.csrf;

    // Logout: revoca la sesión A por jti + limpia la cookie.
    const logout = await request(server)
      .post("/api/auth/logout")
      .set("Cookie", a.cookie);
    expect(logout.status).toBe(204);

    // La cookie revocada ya no autentica → 401 antes incluso de llegar al CSRF.
    const afterLogout = await request(server)
      .post("/api/sources")
      .set("Cookie", a.cookie)
      .set("X-CSRF-Token", tokenATrash)
      .send(validSourceBody);
    expect(afterLogout.status).toBe(401);

    // Nuevo login → nueva sesión → token nuevo y distinto.
    const b = await loginBootstrap(server, nextIp());
    expect(b.csrf).not.toBe(tokenATrash);

    // El token de la sesión anterior NO es válido en la nueva sesión.
    const cross = await request(server)
      .post("/api/sources")
      .set("Cookie", b.cookie)
      .set("X-CSRF-Token", tokenATrash)
      .send(validSourceBody);
    expect(cross.status).toBe(403);

    // El token de la nueva sesión SÍ permite mutar.
    const ok = await request(server)
      .post("/api/sources")
      .set("Cookie", b.cookie)
      .set("X-CSRF-Token", b.csrf)
      .send(validSourceBody);
    expect(ok.status).toBe(201);
  });
});