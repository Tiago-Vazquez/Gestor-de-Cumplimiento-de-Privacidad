import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import type { MockState } from "./mock-repos";

process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.AUTH_BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-only";
process.env.AUTH_BOOTSTRAP_ENABLED = "true"; // 6.3B.15: bootstrap opt-in (ausente = off)

const mocks = vi.hoisted(() => ({
  state: undefined as MockState | undefined,
  repos: undefined as unknown,
}));

vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(), end: vi.fn() } }));
vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  const created = createMockRepos();
  mocks.state = created.state;
  mocks.repos = created.repos;
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

function rolesOf(sub: string): string[] {
  return state().userRoles
    .filter((r) => r.userSub === sub)
    .map((r) => r.role)
    .sort();
}

describe("Login transaccional (6.3B.12 - cierre del riesgo U3)", () => {
  let server: ReturnType<Express["listen"]>;
  let adminJwt: string;
  let workerSub: string;

  beforeAll(async () => {
    server = app.listen(0);
    const boot = await request(server)
      .post("/api/auth/login")
      .send({ token: "bootstrap-token-for-tests-only" });
    expect(boot.status).toBe(200);
    adminJwt = extractJwt(boot.headers["set-cookie"]);

    const reg = await request(server)
      .post("/api/auth/register")
      .send({ email: "worker@example.com", password: "secure-password-123" });
    expect(reg.status).toBe(201);
    workerSub = reg.body.sub;
    expect(rolesOf(workerSub)).toEqual(["auditor"]);
  });

  afterAll(() => {
    server.close();
  });

  it("promocion: el login lee los roles ACTUALES y emite JWT admin", async () => {
    const promote = await request(server)
      .patch(`/api/users/${workerSub}/roles`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ roles: ["admin"] });
    expect(promote.status).toBe(200);
    expect(rolesOf(workerSub)).toEqual(["admin"]);

    const login = await request(server)
      .post("/api/auth/login")
      .send({ email: "worker@example.com", password: "secure-password-123" });
    expect(login.status).toBe(200);
    expect(login.body.sub).toBe(workerSub);
    expect(login.body.roles).toEqual(["admin"]);

    const jwt = extractJwt(login.headers["set-cookie"]);
    const me = await request(server)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${jwt}`);
    expect(me.status).toBe(200);
    expect(me.body.roles).toEqual(["admin"]);

    const users = await request(server)
      .get("/api/users")
      .set("Authorization", `Bearer ${jwt}`);
    expect(users.status).toBe(200);
  });

  it("democion: login posterior NO emite JWT admin stale (admin-only -> 403)", async () => {
    const demote = await request(server)
      .patch(`/api/users/${workerSub}/roles`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ roles: ["auditor"] });
    expect(demote.status).toBe(200);
    expect(rolesOf(workerSub)).toEqual(["auditor"]);

    const login = await request(server)
      .post("/api/auth/login")
      .send({ email: "worker@example.com", password: "secure-password-123" });
    expect(login.status).toBe(200);
    expect(login.body.roles).toEqual(["auditor"]);

    const jwt = extractJwt(login.headers["set-cookie"]);
    const me = await request(server)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${jwt}`);
    expect(me.status).toBe(200);
    expect(me.body.roles).toEqual(["auditor"]);

    const users = await request(server)
      .get("/api/users")
      .set("Authorization", `Bearer ${jwt}`);
    expect(users.status).toBe(403);
  });
  it("rollback: fallo del alta de sesion -> 500, sin cookie ni fila nueva", async () => {
    const sub = workerSub;
    const before = state().sessions.filter((s) => s.userSub === sub).length;

    // El mock replica el contrato transaccional: la unica operacion que crea
    // sesiones es createSessionForUser. Parchearla para fallar tras firmar
    // (como un INSERT fallido dentro de la tx) reproduce el ROLLBACK: el
    // estado no se muta y la ruta no emite cookie.
    const sessionsPatch = mocks.repos as unknown as {
      sessions: {
        createSessionForUser: (
          sub: string,
          buildToken: (roles: string[]) => Promise<string>,
        ) => Promise<{ jwt: string; roles: string[] }>;
      };
    };
    const original = sessionsPatch.sessions.createSessionForUser;
    sessionsPatch.sessions.createSessionForUser = async (sub, buildToken) => {
      const roles = state().userRoles
        .filter((r) => r.userSub === sub)
        .map((r) => r.role);
      await buildToken(roles); // la firma ocurre; el alta falla despues
      throw new Error("simulated session insert failure");
    };
    try {
      const res = await request(server)
        .post("/api/auth/login")
        .send({ email: "worker@example.com", password: "secure-password-123" });
      expect(res.status).toBe(500);
      expect(res.headers["set-cookie"]).toBeUndefined();
    } finally {
      sessionsPatch.sessions.createSessionForUser = original;
    }

    const after = state().sessions.filter((s) => s.userSub === sub).length;
    expect(after).toBe(before);
  });

  it("bootstrap sigue funcionando (roles reales + sesion alta)", async () => {
    const login = await request(server)
      .post("/api/auth/login")
      .send({ token: "bootstrap-token-for-tests-only" });
    expect(login.status).toBe(200);
    expect(login.body.sub).toBe("bootstrap-admin");
    expect(login.body.roles).toContain("admin");

    const jwt = extractJwt(login.headers["set-cookie"]);
    const me = await request(server)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${jwt}`);
    expect(me.status).toBe(200);
    expect(me.body.roles).toContain("admin");

    const users = await request(server)
      .get("/api/users")
      .set("Authorization", `Bearer ${jwt}`);
    expect(users.status).toBe(200);
  });
});

