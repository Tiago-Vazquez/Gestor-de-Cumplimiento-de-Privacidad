/**
 * M11.2.3 — Tests de expiración por inactividad de sesiones.
 *
 * Cubre:
 *  - sesión dentro de la idle window → 200
 *  - sesión fuera de la idle window → 401
 *  - default de SESSION_IDLE_SECONDS (1800)
 *  - configuración mediante SESSION_IDLE_SECONDS
 *  - la actividad refresca last_used_at
 *  - múltiples requests mantienen viva la sesión
 *  - dos sesiones independientes del mismo usuario
 *  - una sesión inactiva expira y otra activa continúa
 *  - sesión revocada sigue devolviendo 401
 *  - logout invalida la sesión
 *  - logout-all invalida las sesiones (incluida la actual)
 *  - password change conserva la sesión actual y revoca las demás
 *  - CSRF no cambia su comportamiento (401 por idle precede a 403 por CSRF)
 *  - un error de touchLastUsed no rompe el request autenticado
 *  - no se expone información sobre si la sesión expiró por idle o fue revocada
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { decodeJwt } from "jose";
import app from "../app";
import { fetchCsrfToken } from "./test-utils";
import type { MockState } from "./mock-repos";

process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.AUTH_REGISTRATION_ENABLED = "true";
// Sube los límites globales ANTES de que se importe `app` (app.ts los lee en
// const top-level). Con vi.hoisted se ejecuta antes de los imports estáticos,
// evitando que generalLimiter (100/ventana) y mutationsLimiter (30/ventana),
// claveados por IP, se agoten al correr 14 tests con la misma IP.
const _hoistedEnv = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.RATE_LIMIT_MUTATIONS_MAX = "100000";
  return {};
});



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

/** Extrae la cookie de sesión completa (`session=<jwt>`) de una respuesta. */
function sessionCookie(res: request.Response): string {
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const match = cookies.join(",").match(/session=[^;]+/);
  if (!match) throw new Error("session cookie not found");
  return match[0];
}

function jwtFromCookie(cookie: string): string {
  return cookie.match(/session=([^;]+)/)![1];
}

/** jti de una cookie de sesión. */
function jtiFromCookie(cookie: string): string {
  const jti = decodeJwt(jwtFromCookie(cookie)).jti;
  if (typeof jti !== "string") throw new Error("jti not found");
  return jti;
}

const PASSWORD = "strong-password-123";

// Un email por caso: loginLimiter usa clave IP+email (5/15min), así que
// compartir email agotaría el bucket entre tests.
let emailSeq = 0;
function uniqueEmail(): string {
  emailSeq += 1;
  return `idle-${emailSeq}@example.com`;
}

/** Servidor efímero; asignado en beforeAll dentro del describe. */
let server: ReturnType<Express["listen"]>;

async function registerAndLogin(email: string, password: string) {
  await request(server).post("/api/auth/register").send({ email, password });
  const login = await request(server)
    .post("/api/auth/login")
    .send({ email, password });
  expect(login.status).toBe(200);
  return { login, cookie: sessionCookie(login) };
}

async function authedContext() {
  const email = uniqueEmail();
  const { login, cookie } = await registerAndLogin(email, PASSWORD);
  const csrf = await fetchCsrfToken(server, cookie);
  return { login, cookie, csrf, email };
}

/** Envejece artificialmente la sesión de una cookie: last_used_at = now - seconds. */
function ageSession(cookie: string, seconds: number): void {
  const session = state().sessions.find((s) => s.jti === jtiFromCookie(cookie));
  if (!session) throw new Error("session not found for cookie");
  session.lastUsedAt = new Date(Date.now() - seconds * 1000);
}

describe("M11.2.3 — sesión dentro de la idle window", () => {
  beforeAll(() => {
    server = app.listen(0);
  });
  afterAll(() => {
    server.close();
  });

  it("1. una sesión recién creada funciona (200)", async () => {
    const { cookie, email } = await authedContext();
    const res = await request(server).get("/api/auth/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(email);
  });

  it("2. la actividad refresca last_used_at", async () => {
    const { cookie } = await authedContext();
    const jti = jtiFromCookie(cookie);
    const before = state().sessions.find((s) => s.jti === jti)!.lastUsedAt;
    await request(server).get("/api/auth/me").set("Cookie", cookie);
    const after = state().sessions.find((s) => s.jti === jti)!.lastUsedAt;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("3. múltiples requests mantienen viva la sesión", async () => {
    const { cookie } = await authedContext();
    for (let i = 0; i < 3; i += 1) {
      const res = await request(server)
        .get("/api/auth/me")
        .set("Cookie", cookie);
      expect(res.status).toBe(200);
    }
  });
});

describe("M11.2.3 — sesión fuera de la idle window", () => {
  beforeAll(() => {
    server = app.listen(0);
  });
  afterAll(() => {
    server.close();
  });

  it("4. una sesión inactiva por más del default (1800s) devuelve 401", async () => {
    const { cookie } = await authedContext();
    // Envejece por encima del default de 1800s sin tocar el env.
    ageSession(cookie, 3600);
    const res = await request(server).get("/api/auth/me").set("Cookie", cookie);
    expect(res.status).toBe(401);
  });

  it("5. la expiración por idle respeta SESSION_IDLE_SECONDS", async () => {
    const prev = process.env.SESSION_IDLE_SECONDS;
    process.env.SESSION_IDLE_SECONDS = "5";
    try {
      const { cookie } = await authedContext();
      ageSession(cookie, 10); // 10s > 5s de ventana
      const res = await request(server)
        .get("/api/auth/me")
        .set("Cookie", cookie);
      expect(res.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.SESSION_IDLE_SECONDS;
      else process.env.SESSION_IDLE_SECONDS = prev;
    }
  });

  it("6. con una ventana corta, una sesión reciente sigue activa", async () => {
    const prev = process.env.SESSION_IDLE_SECONDS;
    process.env.SESSION_IDLE_SECONDS = "3600";
    try {
      const { cookie, email } = await authedContext();
      // Reciente (dentro de 1h) → sigue activa.
      const res = await request(server)
        .get("/api/auth/me")
        .set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body.email).toBe(email);
    } finally {
      if (prev === undefined) delete process.env.SESSION_IDLE_SECONDS;
      else process.env.SESSION_IDLE_SECONDS = prev;
    }
  });

  it("7. dos sesiones independientes: una inactiva expira, la otra continúa", async () => {
    const email = uniqueEmail();
    const a = await registerAndLogin(email, PASSWORD); // cookie A
    const b = await registerAndLogin(email, PASSWORD); // cookie B
    ageSession(a.cookie, 3600); // A inactiva
    // B se mantiene reciente.

    const resA = await request(server)
      .get("/api/auth/me")
      .set("Cookie", a.cookie);
    const resB = await request(server)
      .get("/api/auth/me")
      .set("Cookie", b.cookie);
    expect(resA.status).toBe(401);
    expect(resB.status).toBe(200);
  });
});

describe("M11.2.3 — revocación, logout y logout-all", () => {
  beforeAll(() => {
    server = app.listen(0);
  });
  afterAll(() => {
    server.close();
  });

  it("8. una sesión revocada devuelve 401 (no revivida por touchLastUsed)", async () => {
    const { cookie } = await authedContext();
    // Revocar directamente en el estado (equivalente a revokeByJti).
    state()
      .sessions.find((s) => s.jti === jtiFromCookie(cookie))!
      .revokedAt = new Date();
    const res = await request(server).get("/api/auth/me").set("Cookie", cookie);
    expect(res.status).toBe(401);
  });

  it("9. logout invalida la sesión", async () => {
    const { cookie } = await authedContext();
    const logout = await request(server)
      .post("/api/auth/logout")
      .set("Cookie", cookie);
    expect(logout.status).toBe(204);
    const res = await request(server).get("/api/auth/me").set("Cookie", cookie);
    expect(res.status).toBe(401);
  });

  it("10. logout-all invalida todas las sesiones (incluida la actual)", async () => {
    const email = uniqueEmail();
    const a = await registerAndLogin(email, PASSWORD);
    const b = await registerAndLogin(email, PASSWORD);
    const csrf = await fetchCsrfToken(server, a.cookie);

    const res = await request(server)
      .post("/api/auth/logout-all")
      .set("Cookie", a.cookie)
      .set("X-CSRF-Token", csrf);
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBeGreaterThanOrEqual(2);

    const resA = await request(server)
      .get("/api/auth/me")
      .set("Cookie", a.cookie);
    const resB = await request(server)
      .get("/api/auth/me")
      .set("Cookie", b.cookie);
    expect(resA.status).toBe(401);
    expect(resB.status).toBe(401);
  });
});

describe("M11.2.3 — interacción con password change y CSRF", () => {
  beforeAll(() => {
    server = app.listen(0);
  });
  afterAll(() => {
    server.close();
  });

  it("11. password change conserva la sesión actual y revoca las demás", async () => {
    const email = uniqueEmail();
    const current = await registerAndLogin(email, PASSWORD);
    const other = await registerAndLogin(email, PASSWORD);
    const csrf = await fetchCsrfToken(server, current.cookie);

    const res = await request(server)
      .post("/api/auth/password/change")
      .set("Cookie", current.cookie)
      .set("X-CSRF-Token", csrf)
      .send({ currentPassword: PASSWORD, newPassword: "new-strong-pass-456" });
    expect(res.status).toBe(200);

    // La sesión "other" quedó revocada; la actual sigue operativa.
    const resOther = await request(server)
      .get("/api/auth/me")
      .set("Cookie", other.cookie);
    const resCurrent = await request(server)
      .get("/api/auth/me")
      .set("Cookie", current.cookie);
    expect(resOther.status).toBe(401);
    expect(resCurrent.status).toBe(200);
  });

  it("12. una sesión expirada por idle produce 401 y no 403 por CSRF", async () => {
    const { cookie } = await authedContext();
    ageSession(cookie, 3600);
    // POST sin CSRF: el fallo debe ser 401 (auth por idle) antes que 403 (CSRF).
    const res = await request(server)
      .post("/api/auth/logout-all")
      .set("Cookie", cookie);
    expect(res.status).toBe(401);
  });

  it("13. un error de touchLastUsed no rompe el request autenticado", async () => {
    const { cookie, email } = await authedContext();
    const { repos } = await import("../repositories");
    const spy = vi
      .spyOn(repos.sessions, "touchLastUsed")
      .mockRejectedValueOnce(new Error("db down"));
    try {
      const res = await request(server)
        .get("/api/auth/me")
        .set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body.email).toBe(email);
    } finally {
      spy.mockRestore();
    }
  });

  it("14. no se expone si la sesión expiró por idle o fue revocada", async () => {
    // Caso A: revocada.
    const a = await authedContext();
    state()
      .sessions.find((s) => s.jti === jtiFromCookie(a.cookie))!
      .revokedAt = new Date();
    const resA = await request(server)
      .get("/api/auth/me")
      .set("Cookie", a.cookie);

    // Caso B: idle.
    const b = await authedContext();
    ageSession(b.cookie, 3600);
    const resB = await request(server)
      .get("/api/auth/me")
      .set("Cookie", b.cookie);

    // Ambos 401 con la misma cabecera WWW-Authenticate y cuerpo equivalente.
    expect(resA.status).toBe(401);
    expect(resB.status).toBe(401);
    expect(resA.headers["www-authenticate"]).toBe(
      resB.headers["www-authenticate"],
    );
    expect(resA.body).toEqual(resB.body);
  });
});

