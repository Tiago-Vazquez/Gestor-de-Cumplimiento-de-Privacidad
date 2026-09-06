/**
 * F2 (6.3B.20): kill switch AUTH_REGISTRATION_ENABLED.
 *
 * Contrato fail-closed: SOLO "true"|"1" habilita el registro publico;
 * ausente, vacio o cualquier otro valor (incluido "TRUE", "False", "yes")
 * lo mantiene deshabilitado. Deshabilitado: 401 uniforme (misma respuesta
 * que credencial invalida, no filtra si un email existe), CERO escrituras
 * (usuarios/roles/sesiones) y sin JWT. El login local de usuarios
 * existentes NO se ve afectado.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import type { MockState } from "./mock-repos";

process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.AUTH_BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-only";
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
const nextIp = (): string => `10.78.0.${++ipSeq}`;

function snapshot() {
  return {
    users: state().users.length,
    roles: state().userRoles.length,
    sessions: state().sessions.length,
  };
}

async function register(server: ReturnType<Express["listen"]>, email: string) {
  return request(server)
    .post("/api/auth/register")
    .set("X-Forwarded-For", nextIp())
    .send({ email, password: "secure-password-123" });
}

describe("AUTH_REGISTRATION_ENABLED (F2, fail-closed)", () => {
  let server: ReturnType<Express["listen"]>;
  beforeAll(() => {
    server = app.listen(0);
  });
  afterAll(() => {
    server.close();
  });
  afterEach(() => {
    process.env.AUTH_REGISTRATION_ENABLED = "true";
  });

  it("ausente -> 401 y CERO mutaciones", async () => {
    delete process.env.AUTH_REGISTRATION_ENABLED;
    const before = snapshot();
    const res = await register(server, "unset@example.com");
    expect(res.status).toBe(401);
    expect(snapshot()).toEqual(before);
  });

  it('"false" -> 401 y CERO mutaciones', async () => {
    process.env.AUTH_REGISTRATION_ENABLED = "false";
    const before = snapshot();
    const res = await register(server, "false@example.com");
    expect(res.status).toBe(401);
    expect(snapshot()).toEqual(before);
  });

  it('"0" -> rechazado', async () => {
    process.env.AUTH_REGISTRATION_ENABLED = "0";
    const before = snapshot();
    const res = await register(server, "zero@example.com");
    expect(res.status).toBe(401);
    expect(snapshot()).toEqual(before);
  });

  it('"TRUE" (mayusculas) -> rechazado', async () => {
    process.env.AUTH_REGISTRATION_ENABLED = "TRUE";
    const res = await register(server, "upper@example.com");
    expect(res.status).toBe(401);
  });

  it('valor arbitrario ("yes") -> rechazado', async () => {
    process.env.AUTH_REGISTRATION_ENABLED = "yes";
    const res = await register(server, "yes@example.com");
    expect(res.status).toBe(401);
  });

  it('"true" -> registro permitido (201)', async () => {
    const res = await register(server, "enabled-true@example.com");
    expect(res.status).toBe(201);
  });

  it('"1" -> registro permitido (201)', async () => {
    const res = await register(server, "enabled-one@example.com");
    expect(res.status).toBe(201);
  });

  it("registro habilitado conserva rol inicial auditor (contrato)", async () => {
    const res = await register(server, "roles@example.com");
    expect(res.status).toBe(201);
    expect(res.body.roles).toEqual(["auditor"]);
    const sub = res.body.sub as string;
    expect(
      state().userRoles.filter((r) => r.userSub === sub).map((r) => r.role),
    ).toEqual(["auditor"]);
  });

  it("deshabilitado NO impide login de usuario existente", async () => {
    const reg = await register(server, "existing@example.com");
    expect(reg.status).toBe(201);
    process.env.AUTH_REGISTRATION_ENABLED = "false";
    const login = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", nextIp())
      .send({ email: "existing@example.com", password: "secure-password-123" });
    expect(login.status).toBe(200);
    expect(login.body.roles).toEqual(["auditor"]);
  });

  it("deshabilitado: sin sesion creada y sin roles nuevos", async () => {
    process.env.AUTH_REGISTRATION_ENABLED = "false";
    const before = snapshot();
    await register(server, "noside@example.com");
    expect(snapshot()).toEqual(before);
  });

  it("deshabilitado: respuesta uniforme (no filtra existencia de email)", async () => {
    process.env.AUTH_REGISTRATION_ENABLED = "false";
    const fresh = await register(server, "fresh@example.com");
    const dup = await register(server, "existing@example.com");
    expect(fresh.status).toBe(401);
    expect(dup.status).toBe(401);
    expect(fresh.body).toEqual(dup.body);
    expect(fresh.headers["set-cookie"]).toEqual(dup.headers["set-cookie"]);
  });
});
