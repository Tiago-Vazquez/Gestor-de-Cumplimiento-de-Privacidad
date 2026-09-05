import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { decodeJwt } from "jose";
import app from "../app";
import type { MockState } from "./mock-repos";

process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.AUTH_BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-only";
process.env.AUTH_BOOTSTRAP_ENABLED = "true"; // 6.3B.15: bootstrap opt-in (ausente = off)

// El factory de vi.mock corre durante la evaluación de imports (antes del body
// de este módulo); vi.hoisted evita el TDZ al asignarle desde el factory.
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

function extractJwt(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const match = cookies.join(",").match(/session=([^;]+)/);
  if (!match) throw new Error("session cookie not found");
  return match[1];
}

/**
 * Circuito completo del allowlist de sesiones: login crea la fila, logout la
 * revoca, y `requireAuth` rechaza el replay de un JWT revocado.
 *
 * NOTA (6.3B.12): `requireAuth` EXIGE fila de sesion activa; un JWT con
 * `jti` sin fila (o revocada o expirada) devuelve 401. Los tests que
 * firman tokens directos sin pasar por /login (p. ej. auth.test.ts)
 * crean su fila explícitamente en `state().sessions`.
 */
describe("Session allowlist (login rows / logout revoke / replay 401)", () => {
  let server: ReturnType<Express["listen"]>;

  beforeAll(() => {
    server = app.listen(0);
  });
  afterAll(() => {
    server.close();
  });

  it("A. local login creates a session row matching the emitted JWT", async () => {
    await request(server).post("/api/auth/register").send({
      email: "sessions-a@example.com",
      password: "secure-password-123",
    });
    const login = await request(server).post("/api/auth/login").send({
      email: "sessions-a@example.com",
      password: "secure-password-123",
    });
    expect(login.status).toBe(200);

    const jwt = extractJwt(login.headers["set-cookie"]);
    const { jti, sub, exp } = decodeJwt(jwt);
    expect(jti).toBeDefined();
    expect(exp).toBeDefined();

    const row = state().sessions.find((s) => s.jti === jti);
    expect(row).toBeDefined();
    expect(row!.userSub).toBe(sub);
    expect(row!.revokedAt).toBeNull();
    // La fila refleja exactamente el exp del token (expiración autoritativa).
    expect(row!.expiresAt.getTime()).toBe(exp! * 1000);
    expect(row!.issuedAt).toBeInstanceOf(Date);
  });

  it("B. bootstrap login creates a session row (same logic)", async () => {
    const login = await request(server)
      .post("/api/auth/login")
      .send({ token: "bootstrap-token-for-tests-only" });
    expect(login.status).toBe(200);
    expect(login.body.sub).toBe("bootstrap-admin");

    const jwt = extractJwt(login.headers["set-cookie"]);
    const { jti, exp } = decodeJwt(jwt);
    expect(jti).toBeDefined();

    const row = state().sessions.find((s) => s.jti === jti);
    expect(row).toBeDefined();
    expect(row!.userSub).toBe("bootstrap-admin");
    expect(row!.revokedAt).toBeNull();
    expect(row!.expiresAt.getTime()).toBe(exp! * 1000);
  });

  it("C. logout revokes the session row of the presented JWT", async () => {
    await request(server).post("/api/auth/register").send({
      email: "sessions-c@example.com",
      password: "secure-password-123",
    });
    const login = await request(server).post("/api/auth/login").send({
      email: "sessions-c@example.com",
      password: "secure-password-123",
    });
    expect(login.status).toBe(200);

    const jwt = extractJwt(login.headers["set-cookie"]);
    const { jti } = decodeJwt(jwt);

    const before = state().sessions.find((s) => s.jti === jti);
    expect(before).toBeDefined();
    expect(before!.revokedAt).toBeNull();

    const logout = await request(server)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${jwt}`);
    expect(logout.status).toBe(204);

    const after = state().sessions.find((s) => s.jti === jti);
    expect(after).toBeDefined();
    expect(after!.revokedAt).not.toBeNull();
  });

  it("D. replaying a revoked JWT returns 401", async () => {
    await request(server).post("/api/auth/register").send({
      email: "sessions-d@example.com",
      password: "secure-password-123",
    });
    const login = await request(server).post("/api/auth/login").send({
      email: "sessions-d@example.com",
      password: "secure-password-123",
    });
    expect(login.status).toBe(200);

    const jwt = extractJwt(login.headers["set-cookie"]);

    // Antes del logout el JWT es válido (fila activa).
    const before = await request(server)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${jwt}`);
    expect(before.status).toBe(200);

    const logout = await request(server)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${jwt}`);
    expect(logout.status).toBe(204);

    // Replay tras el logout: firma válida, pero la fila existe y está
    // revocada → 401 con la misma respuesta que el resto de fallos de auth.
    const replay = await request(server)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${jwt}`);
    expect(replay.status).toBe(401);
    expect(replay.headers["www-authenticate"]).toContain("Bearer");
  });

  it("E. logout without token/cookie still returns 204", async () => {
    const res = await request(server).post("/api/auth/logout");
    expect(res.status).toBe(204);
  });
});

