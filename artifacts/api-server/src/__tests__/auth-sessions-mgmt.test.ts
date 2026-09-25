/**
 * M11.2.2 — Gestion de sesiones propias.
 *
 * Cubre GET /api/auth/sessions, DELETE /api/auth/sessions/:jti y
 * POST /api/auth/logout-all contra los handlers reales de `src/routes/auth.ts`.
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
// Sube los limites globales ANTES de que se importe `app` (app.ts los lee en
// const top-level): la suite completa de gestion de sesiones supera el bucket
// por defecto (100/min general, 30/min mutaciones) al compartir IP.
// `vi.hoisted` corre antes de los imports estaticos.
vi.hoisted(() => {
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

const PASSWORD = "session-mgmt-pass-123";

/** Email unico por caso: los limiters de register/login usan clave IP+email. */
let emailSeq = 0;
function uniqueEmail(): string {
  emailSeq += 1;
  return `session-mgmt-${emailSeq}@example.com`;
}

/** Cookie de sesion completa (`session=<jwt>`) de una respuesta. */
function cookieOf(res: request.Response): string {
  const setCookie = res.headers["set-cookie"];
  const all = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  const match = all.join(",").match(/session=[^;]+/);
  if (!match) throw new Error("session cookie not found");
  return match[0];
}

function jwtOf(cookie: string): string {
  return cookie.match(/session=([^;]+)/)![1];
}

function jtiOf(cookie: string): string {
  return String(decodeJwt(jwtOf(cookie)).jti);
}

let server: ReturnType<Express["listen"]>;

/** Registra (idempotente) y hace login devolviendo cookie + jti. */
async function loginAs(email: string) {
  await request(server).post("/api/auth/register").send({ email, password: PASSWORD });
  const res = await request(server).post("/api/auth/login").send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookie = cookieOf(res);
  return { cookie, jti: jtiOf(cookie) };
}

/** Usuario nuevo con una sesion activa y su token CSRF. */
async function newUser() {
  const email = uniqueEmail();
  const session = await loginAs(email);
  return { ...session, email };
}

/** Fila de sesion en el estado mock (puede ser undefined). */
function rowOf(jti: string) {
  return state().sessions.find((s) => s.jti === jti);
}

describe("M11.2.2 - self-service session management", () => {
  beforeAll(() => {
    server = app.listen(0);
  });
  afterAll(() => {
    server.close();
  });

  describe("GET /api/auth/sessions", () => {
    it("A. rechaza sin sesion (401)", async () => {
      const res = await request(server).get("/api/auth/sessions");
      expect(res.status).toBe(401);
    });

    it("B. lista solo las sesiones del usuario autenticado", async () => {
      const me = await newUser();
      const second = await loginAs(me.email);
      const other = await newUser();
      const res = await request(server).get("/api/auth/sessions").set("Cookie", me.cookie);
      expect(res.status).toBe(200);
      const jtis = res.body.sessions.map((s: { jti: string }) => s.jti);
      expect(jtis).toContain(me.jti);
      expect(jtis).toContain(second.jti);
      expect(jtis).not.toContain(other.jti);
    });

    it("C. marca exactamente una sesion como current", async () => {
      const me = await newUser();
      await loginAs(me.email);
      const res = await request(server).get("/api/auth/sessions").set("Cookie", me.cookie);
      expect(res.status).toBe(200);
      const currents = res.body.sessions.filter((s: { current: boolean }) => s.current);
      expect(currents).toHaveLength(1);
      expect(currents[0].jti).toBe(me.jti);
    });

    it("D. no expone secretos en la respuesta", async () => {
      const me = await newUser();
      const res = await request(server).get("/api/auth/sessions").set("Cookie", me.cookie);
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain("csrf");
      expect(body).not.toContain("token");
      expect(body).not.toContain("passwordHash");
      expect(body).not.toContain("expiresAt_") ;
    });

    it("E. cada sesion expone solo jti/createdAt/expiresAt/current", async () => {
      const me = await newUser();
      const res = await request(server).get("/api/auth/sessions").set("Cookie", me.cookie);
      expect(res.status).toBe(200);
      expect(res.body.sessions.length).toBeGreaterThan(0);
      for (const s of res.body.sessions) {
        expect(Object.keys(s).sort()).toEqual(["createdAt", "current", "expiresAt", "jti"]);
      }
    });

    it("F. omite las sesiones revocadas", async () => {
      const me = await newUser();
      const second = await loginAs(me.email);
      const csrf = await fetchCsrfToken(server, me.cookie);
      const del = await request(server)
        .delete(`/api/auth/sessions/${second.jti}`)
        .set("Cookie", me.cookie)
        .set("X-CSRF-Token", csrf);
      expect(del.status).toBe(200);
      const res = await request(server).get("/api/auth/sessions").set("Cookie", me.cookie);
      const jtis = res.body.sessions.map((s: { jti: string }) => s.jti);
      expect(jtis).not.toContain(second.jti);
      expect(jtis).toContain(me.jti);
    });

    it("G. no permite enumerar sesiones de otro usuario", async () => {
      const a = await newUser();
      const b = await newUser();
      const res = await request(server).get("/api/auth/sessions").set("Cookie", a.cookie);
      expect(res.status).toBe(200);
      const jtis = res.body.sessions.map((s: { jti: string }) => s.jti);
      expect(jtis).not.toContain(b.jti);
    });
  });
describe("DELETE /api/auth/sessions/:jti", () => {
    it("H. rechaza sin sesion (401)", async () => {
      const res = await request(server).delete("/api/auth/sessions/unknown-jti");
      expect(res.status).toBe(401);
    });

    it("I. revoca una sesion propia y la deja inutilizable", async () => {
      const me = await newUser();
      const second = await loginAs(me.email);
      const csrf = await fetchCsrfToken(server, me.cookie);
      const del = await request(server)
        .delete(`/api/auth/sessions/${second.jti}`)
        .set("Cookie", me.cookie)
        .set("X-CSRF-Token", csrf);
      expect(del.status).toBe(200);
      expect(del.body).toEqual({ revoked: true });
      // La fila quedo revocada...
      expect(rowOf(second.jti)?.revokedAt).not.toBeNull();
      // ...y su cookie ya no autentica.
      const after = await request(server).get("/api/auth/me").set("Cookie", second.cookie);
      expect(after.status).toBe(401);
    });

    it("J. una sesion ajena responde 404 uniforme (nunca 403)", async () => {
      const a = await newUser();
      const b = await newUser();
      const csrf = await fetchCsrfToken(server, a.cookie);
      const res = await request(server)
        .delete(`/api/auth/sessions/${b.jti}`)
        .set("Cookie", a.cookie)
        .set("X-CSRF-Token", csrf);
      expect(res.status).toBe(404);
      // El intento no toco la sesion de B.
      expect(rowOf(b.jti)?.revokedAt).toBeNull();
    });

    it("K. un jti inexistente responde 404", async () => {
      const me = await newUser();
      const csrf = await fetchCsrfToken(server, me.cookie);
      const res = await request(server)
        .delete("/api/auth/sessions/00000000-0000-0000-0000-000000000000")
        .set("Cookie", me.cookie)
        .set("X-CSRF-Token", csrf);
      expect(res.status).toBe(404);
    });

    it("L. una sesion ya revocada responde el mismo 404 que una inexistente", async () => {
      const me = await newUser();
      const second = await loginAs(me.email);
      const csrf = await fetchCsrfToken(server, me.cookie);
      const first = await request(server)
        .delete(`/api/auth/sessions/${second.jti}`)
        .set("Cookie", me.cookie)
        .set("X-CSRF-Token", csrf);
      expect(first.status).toBe(200);

      const revokedAgain = await request(server)
        .delete(`/api/auth/sessions/${second.jti}`)
        .set("Cookie", me.cookie)
        .set("X-CSRF-Token", csrf);
      const missing = await request(server)
        .delete("/api/auth/sessions/00000000-0000-0000-0000-000000000000")
        .set("Cookie", me.cookie)
        .set("X-CSRF-Token", csrf);

      // Mismo estatus y mismos campos de seguridad (type/title/status/detail):
      // no se puede distinguir una sesion ya revocada de una inexistente
      // (no hay canal de enumeracion). `instance` es el path del propio
      // request, no una propiedad del recurso, asi que no participa.
      expect(revokedAgain.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(revokedAgain.body).toMatchObject({
        type: "about:blank",
        title: "Not Found",
        status: 404,
        detail: "Session not found",
      });
      expect(missing.body).toMatchObject({
        type: "about:blank",
        title: "Not Found",
        status: 404,
        detail: "Session not found",
      });
    });

    it("M. permite revocar la sesion actual; luego deja de autenticar (401)", async () => {
      const me = await newUser();
      const csrf = await fetchCsrfToken(server, me.cookie);
      const res = await request(server)
        .delete(`/api/auth/sessions/${me.jti}`)
        .set("Cookie", me.cookie)
        .set("X-CSRF-Token", csrf);
      expect(res.status).toBe(200);
      const after = await request(server).get("/api/auth/me").set("Cookie", me.cookie);
      expect(after.status).toBe(401);
    });
  });
describe("DELETE /api/auth/sessions/:jti - CSRF", () => {
    it("N. rechaza sin header CSRF (403) y no revoca la sesion", async () => {
      const me = await newUser();
      const second = await loginAs(me.email);
      const res = await request(server)
        .delete(`/api/auth/sessions/${second.jti}`)
        .set("Cookie", me.cookie);
      expect(res.status).toBe(403);
      expect(rowOf(second.jti)?.revokedAt).toBeNull();
    });
  });

  describe("POST /api/auth/logout-all", () => {
    it("O. rechaza sin sesion (401)", async () => {
      const res = await request(server).post("/api/auth/logout-all");
      expect(res.status).toBe(401);
    });

    it("P. rechaza sin header CSRF (403) y no revoca ninguna sesion", async () => {
      const me = await newUser();
      const res = await request(server).post("/api/auth/logout-all").set("Cookie", me.cookie);
      expect(res.status).toBe(403);
      expect(rowOf(me.jti)?.revokedAt).toBeNull();
    });

    it("Q. revoca todas las sesiones del usuario, incluida la actual", async () => {
      const me = await newUser();
      const second = await loginAs(me.email);
      const csrf = await fetchCsrfToken(server, me.cookie);
      const res = await request(server)
        .post("/api/auth/logout-all")
        .set("Cookie", me.cookie)
        .set("X-CSRF-Token", csrf);
      expect(res.status).toBe(200);
      expect(res.body.revoked).toBeGreaterThanOrEqual(2);
      const current = await request(server).get("/api/auth/me").set("Cookie", me.cookie);
      expect(current.status).toBe(401);
      const other = await request(server).get("/api/auth/me").set("Cookie", second.cookie);
      expect(other.status).toBe(401);
    });

    it("R. no afecta las sesiones de otros usuarios", async () => {
      const me = await newUser();
      const other = await newUser();
      const csrf = await fetchCsrfToken(server, me.cookie);
      const res = await request(server)
        .post("/api/auth/logout-all")
        .set("Cookie", me.cookie)
        .set("X-CSRF-Token", csrf);
      expect(res.status).toBe(200);
      expect(rowOf(other.jti)?.revokedAt).toBeNull();
      const still = await request(server).get("/api/auth/me").set("Cookie", other.cookie);
      expect(still.status).toBe(200);
    });
  });
});