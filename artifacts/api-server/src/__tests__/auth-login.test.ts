import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { decodeJwt } from "jose";
import app from "../app";
import { signToken } from "../auth/tokens";
import { logger } from "../lib/logger";
import type { MockState } from "./mock-repos";

// Suite con autenticación REAL: activamos JWT para validar el flujo de login.
process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.AUTH_BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-only";
process.env.AUTH_BOOTSTRAP_ENABLED = "true"; // 6.3B.15: bootstrap opt-in (ausente = off)

vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(), end: vi.fn() } }));
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

/** Cutover del allowlist (6.3B.5e): un JWT firmado ad-hoc necesita su fila de
 * sesión activa en `sessions` para ser aceptado por requireAuth(). */
function seedSessionFor(token: string) {
  const { jti, sub, exp } = decodeJwt(token);
  state().sessions.push({
    jti: jti!,
    userSub: sub!,
    issuedAt: new Date(),
    expiresAt: new Date((exp ?? 0) * 1000),
    revokedAt: null,
  });
}

describe("Auth flow (login / logout / me)", () => {
  let server: ReturnType<Express["listen"]>;
  let adminToken: string;

  beforeAll(async () => {
    server = app.listen(0);
    adminToken = await signToken({
      sub: "admin-1",
      email: "admin@test.local",
      name: "Admin",
      roles: ["admin"],
    });
    seedSessionFor(adminToken);
  });

  afterAll(() => {
    server.close();
  });

  it("login válido → 200 + Set-Cookie httpOnly", async () => {
    const res = await request(server)
      .post("/api/auth/login")
      .send({ token: "bootstrap-token-for-tests-only" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sub: "bootstrap-admin", roles: ["admin"] });
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookies = (Array.isArray(setCookie) ? setCookie : [setCookie]).join(",");
    expect(cookies).toContain("session=");
    expect(cookies).toContain("HttpOnly");
  });

  it("login inválido → 401", async () => {
    const res = await request(server)
      .post("/api/auth/login")
      .send({ token: "wrong-token" });
    expect(res.status).toBe(401);
    expect(res.body.status).toBe(401);
  });

  it("login sin token en body → 400", async () => {
    const res = await request(server).post("/api/auth/login").send({});
    expect(res.status).toBe(400);
    expect(res.body.status).toBe(400);
  });

  it("/api/auth/me sin sesión → 401", async () => {
    const res = await request(server).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("/api/auth/me con JWT válido → 200 + identidad", async () => {
    const res = await request(server)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sub: "admin-1",
      email: "admin@test.local",
      roles: ["admin"],
    });
  });

  it("logout → 204 + cookie borrada", async () => {
    const res = await request(server).post("/api/auth/logout");
    expect(res.status).toBe(204);
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookies = (Array.isArray(setCookie) ? setCookie : [setCookie]).join(",");
    expect(cookies).toContain("session=;");
  });

  it("no loguea tokens ni JWT en los logs", async () => {
    const infoSpy = vi.spyOn(logger, "info");
    const errorSpy = vi.spyOn(logger, "error");
    await request(server)
      .post("/api/auth/login")
      .send({ token: "bootstrap-token-for-tests-only" });
    const allLogs = [
      ...infoSpy.mock.calls.map((c) => JSON.stringify(c)),
      ...errorSpy.mock.calls.map((c) => JSON.stringify(c)),
    ].join(" ");
    expect(allLogs).not.toContain("bootstrap-token-for-tests-only");
    expect(allLogs).not.toContain("session");
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });
});