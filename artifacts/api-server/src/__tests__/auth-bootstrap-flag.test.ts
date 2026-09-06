import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { decodeJwt } from "jose";
import app from "../app";
import { bootstrapProductionWarning } from "../routes/auth";
import type { MockState } from "./mock-repos";

process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.AUTH_REGISTRATION_ENABLED = "true"; // 6.3B.20: registro opt-in (ausente = off)
process.env.AUTH_BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-only";

// El factory de vi.mock corre durante la evaluacion de imports (antes del body
// de este modulo); vi.hoisted evita el TDZ al asignarle desde el factory.
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

/** Espias sobre los tres repos mutantes del flujo bootstrap. */
function spyMutatingRepos() {
  const reposPatch = mocks.repos as unknown as {
    users: { upsertBySub: (values: unknown) => Promise<unknown> };
    userRoles: { addRole: (sub: string, role: string) => Promise<void> };
    sessions: { createSessionForUser: (sub: string, build: unknown) => Promise<unknown> };
  };
  const upsertBySub = vi.spyOn(reposPatch.users, "upsertBySub");
  const addRole = vi.spyOn(reposPatch.userRoles, "addRole");
  const createSessionForUser = vi.spyOn(reposPatch.sessions, "createSessionForUser");
  return {
    upsertBySub,
    addRole,
    createSessionForUser,
    restore(): void {
      upsertBySub.mockRestore();
      addRole.mockRestore();
      createSessionForUser.mockRestore();
    },
  };
}

/**
 * Feature flag AUTH_BOOTSTRAP_ENABLED - contrato 6.3B.15 (fail-closed):
 * SOLO "true"|"1" habilita el bootstrap; ausente, vacio o cualquier otro
 * valor lo mantiene deshabilitado. Deshabilitado, la ruta responde 401
 * uniforme y NO toca ningun repositorio (ni upsert, ni addRole, ni sesion)
 * ni emite JWT/cookie. Cada request bootstrap usa una X-Forwarded-For
 * propia para no interferir con el bootstrapLimiter (5/15min por IP).
 */
describe("Bootstrap login feature flag (AUTH_BOOTSTRAP_ENABLED)", () => {
  let server: ReturnType<Express["listen"]>;

  beforeAll(() => {
    server = app.listen(0);
  });
  afterAll(() => {
    server.close();
  });
  afterEach(() => {
    delete process.env.AUTH_BOOTSTRAP_ENABLED;
  });

  it("DISABLED by default when unset (fail-closed 6.3B.15)", async () => {
    delete process.env.AUTH_BOOTSTRAP_ENABLED;
    const before = state().sessions.length;
    const res = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "10.9.0.11")
      .send({ token: "bootstrap-token-for-tests-only" });
    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(state().sessions.length).toBe(before);
  });

  it("disabled (false): 401, sin JWT/cookie y CERO llamadas a repos mutantes", async () => {
    process.env.AUTH_BOOTSTRAP_ENABLED = "false";
    const spies = spyMutatingRepos();
    const sessionsBefore = state().sessions.length;
    const usersBefore = state().users.length;
    try {
      const res = await request(server)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "10.9.0.12")
        .send({ token: "bootstrap-token-for-tests-only" });
      expect(res.status).toBe(401);
      expect(res.body.status).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(spies.upsertBySub).not.toHaveBeenCalled();
      expect(spies.addRole).not.toHaveBeenCalled();
      expect(spies.createSessionForUser).not.toHaveBeenCalled();
      expect(state().sessions.length).toBe(sessionsBefore);
      expect(state().users.length).toBe(usersBefore);
    } finally {
      spies.restore();
    }
  });

  it("disabled (0): mismo 401 sin efectos", async () => {
    process.env.AUTH_BOOTSTRAP_ENABLED = "0";
    const before = state().sessions.length;
    const res = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "10.9.0.13")
      .send({ token: "bootstrap-token-for-tests-only" });
    expect(res.status).toBe(401);
    expect(state().sessions.length).toBe(before);
  });

  it("fail-closed (TRUE): cualquier valor distinto de true|1 mantiene apagado", async () => {
    process.env.AUTH_BOOTSTRAP_ENABLED = "TRUE";
    const res = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "10.9.0.14")
      .send({ token: "bootstrap-token-for-tests-only" });
    expect(res.status).toBe(401);
  });

  it("enabled (true): login OK, JWT con jti y fila de sesion creada", async () => {
    process.env.AUTH_BOOTSTRAP_ENABLED = "true";
    const before = state().sessions.length;
    const res = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "10.9.0.15")
      .send({ token: "bootstrap-token-for-tests-only" });
    expect(res.status).toBe(200);

    const jwt = extractJwt(res.headers["set-cookie"]);
    const { jti, sub } = decodeJwt(jwt);
    expect(jti).toBeDefined();
    expect(sub).toBe("bootstrap-admin");

    expect(state().sessions.length).toBe(before + 1);
    const row = state().sessions.find((s) => s.jti === jti);
    expect(row?.userSub).toBe("bootstrap-admin");
    expect(row?.revokedAt).toBeNull();
  });

  it("enabled (1): alias opt-in equivalente", async () => {
    process.env.AUTH_BOOTSTRAP_ENABLED = "1";
    const res = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "10.9.0.16")
      .send({ token: "bootstrap-token-for-tests-only" });
    expect(res.status).toBe(200);
    expect(res.body.sub).toBe("bootstrap-admin");
  });

  it("disabled: el login local NO se ve afectado", async () => {
    process.env.AUTH_BOOTSTRAP_ENABLED = "false";
    await request(server)
      .post("/api/auth/register")
      .send({ email: "local-flag@example.com", password: "secure-password-123" });
    const res = await request(server)
      .post("/api/auth/login")
      .send({ email: "local-flag@example.com", password: "secure-password-123" });
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(["auditor"]);
  });
});

describe("bootstrapProductionWarning (aviso de arranque 6.3B.15)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("no avisa fuera de produccion aunque el flag este activo", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_BOOTSTRAP_ENABLED", "true");
    expect(bootstrapProductionWarning()).toBeNull();
  });

  it("avisa en produccion con el flag activo", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_BOOTSTRAP_ENABLED", "true");
    expect(bootstrapProductionWarning()).toMatch(/AUTH_BOOTSTRAP_ENABLED/);
  });

  it("no avisa en produccion con el flag ausente (default off)", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.AUTH_BOOTSTRAP_ENABLED;
    expect(bootstrapProductionWarning()).toBeNull();
  });
});
