/**
 * M11.2 — Tests funcionales de POST /api/auth/password/change.
 *
 * Cubre:
 *  - 401 sin sesión
 *  - 401 con currentPassword incorrecta (no revela si el email existe)
 *  - 400 con newPassword que no cumple la MISMA política que el registro
 *  - 200 feliz: hash actualizado, sesiones ajenas revocadas y la sesión
 *    actual preservada (exceptJti), con respuesta { ok, revokedSessions }
 *  - 403 sin token CSRF (mutación autenticada por cookie)
 *
 * Sigue las mismas convenciones que auth-sessions.test.ts: repos en memoria
 * (mock-repos), servidor efímero y sesión por cookie.
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

const OLD_PASSWORD = "old-password-123";
const NEW_PASSWORD = "new-password-456";
// Un email por caso: loginLimiter usa clave IP+email (5/15min), así que
// compartir email agotaría el bucket entre tests.
let emailSeq = 0;
function uniqueEmail(): string {
  emailSeq += 1;
  return `pw-change-${emailSeq}@example.com`;
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

/**
 * Helper: registra el usuario de prueba, hace login y devuelve cookie de
 * sesión + token CSRF obtenido del endpoint dedicado.
 */
async function authedContext() {
  const email = uniqueEmail();
  const { login, cookie } = await registerAndLogin(email, OLD_PASSWORD);
  const csrf = await fetchCsrfToken(server, cookie);
  return { login, cookie, csrf, email };
}

/** Verifica una contraseña contra el hash persistido (scrypt del workspace). */
async function verifyStored(
  user: { passwordHash: string | null },
  password: string,
): Promise<boolean> {
  const { verifyPassword } = await import("@workspace/auth");
  if (!user.passwordHash) return false;
  return verifyPassword(password, user.passwordHash);
}

describe("POST /api/auth/password/change", () => {
  beforeAll(() => {
    server = app.listen(0);
  });
  afterAll(() => {
    server.close();
  });

  it("A. rechaza sin sesión (401)", async () => {
    const res = await request(server)
      .post("/api/auth/password/change")
      .send({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
  });

  it("B. rechaza currentPassword incorrecta (401) sin alterar el hash", async () => {
    const { cookie, csrf, email } = await authedContext();

    const res = await request(server)
      .post("/api/auth/password/change")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrf)
      .send({ currentPassword: "wrong-password-xyz", newPassword: NEW_PASSWORD });

    expect(res.status).toBe(401);
    const user = state().users.find((u) => u.email === email)!;
    await expect(verifyStored(user, OLD_PASSWORD)).resolves.toBe(true);
  });

  it("C. rechaza newPassword que no cumple la política del registro (400)", async () => {
    const { cookie, csrf } = await authedContext();

    const res = await request(server)
      .post("/api/auth/password/change")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrf)
      .send({ currentPassword: OLD_PASSWORD, newPassword: "corta" });

    expect(res.status).toBe(400);
  });

  it("D. rechaza si la nueva contraseña coincide con la actual (400)", async () => {
    const { cookie, csrf } = await authedContext();

    const res = await request(server)
      .post("/api/auth/password/change")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrf)
      .send({ currentPassword: OLD_PASSWORD, newPassword: OLD_PASSWORD });

    expect(res.status).toBe(400);
  });

  it("E. rechaza mutación por cookie sin token CSRF (403)", async () => {
    const { cookie } = await authedContext();

    const res = await request(server)
      .post("/api/auth/password/change")
      .set("Cookie", cookie)
      .send({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(403);
  });

  it("F. rota el hash, revoca las demás sesiones y preserva la actual (200)", async () => {
    // Dos sesiones del mismo usuario: "other" debe morir, "current" sobrevive.
    const { cookie, csrf, email } = await authedContext();
    const other = await registerAndLogin(email, OLD_PASSWORD);
    const currentJti = decodeJwt(jwtFromCookie(cookie)).jti;

    const res = await request(server)
      .post("/api/auth/password/change")
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrf)
      .send({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, revokedSessions: 1 });

    // 1) Hash persistido = nueva contraseña (y la vieja ya no vale).
    const user = state().users.find((u) => u.email === email)!;
    await expect(verifyStored(user, NEW_PASSWORD)).resolves.toBe(true);
    await expect(verifyStored(user, OLD_PASSWORD)).resolves.toBe(false);

    // 2) La fila de la sesión actual sigue activa (exceptJti).
    const currentRow = state().sessions.find((s) => s.jti === currentJti);
    expect(currentRow?.revokedAt ?? null).toBeNull();

    // 3) La sesión "other" quedó revocada: replay → 401.
    const otherJwt = jwtFromCookie(sessionCookie(other.login));
    const otherRow = state().sessions.find(
      (s) => s.jti === decodeJwt(otherJwt).jti,
    );
    expect(otherRow?.revokedAt).not.toBeNull();
    const replay = await request(server)
      .get("/api/auth/me")
      .set("Cookie", sessionCookie(other.login));
    expect(replay.status).toBe(401);

    // 4) La sesión actual sigue operativa.
    const me = await request(server).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(email);
  });
});

