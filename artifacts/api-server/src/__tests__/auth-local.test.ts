import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import type { MockState } from "./mock-repos";

process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.AUTH_BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-only";
process.env.AUTH_BOOTSTRAP_ENABLED = "true"; // 6.3B.15: bootstrap opt-in (ausente = off)
process.env.AUTH_REGISTRATION_ENABLED = "true"; // 6.3B.20: registro opt-in (ausente = off)

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

function extractJwt(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const match = cookies.join(",").match(/session=([^;]+)/);
  if (!match) throw new Error("session cookie not found");
  return match[1];
}

// NOTA: el rate limiter de login local permite 5 intentos/15 min. Este archivo
// ejecuta exactamente 5 logins locales; no agregar más sin subir el límite.
describe("Local auth (login / register)", () => {
  let server: ReturnType<Express["listen"]>;
  let auditorRoleSub: string;

  beforeAll(() => { server = app.listen(0); });
  afterAll(() => { server.close(); });

  describe("POST /api/auth/register", () => {
    it("registers a new user with email + password -> 201", async () => {
      const res = await request(server).post("/api/auth/register").send({
        email: "newuser@example.com", password: "secure-password-123", name: "New User",
      });
      expect(res.status).toBe(201);
      expect(res.body.sub).toMatch(/^[0-9a-f-]{36}$/i); // UUID estable, no local:email
      expect(res.body.email).toBe("newuser@example.com");
      expect(res.body.roles).toEqual(["auditor"]);
      expect(res.body.password).toBeUndefined();
      expect(res.body.passwordHash).toBeUndefined();
    });

    it("rejects duplicate email -> 409", async () => {
      await request(server).post("/api/auth/register")
        .send({ email: "dup@example.com", password: "secure-password-123" });
      const res = await request(server).post("/api/auth/register")
        .send({ email: "dup@example.com", password: "another-password-456" });
      expect(res.status).toBe(409);
    });

    it("rejects short password -> 400", async () => {
      const res = await request(server).post("/api/auth/register")
        .send({ email: "short@example.com", password: "short" });
      expect(res.status).toBe(400);
    });

    it("rejects invalid email -> 400", async () => {
      const res = await request(server).post("/api/auth/register")
        .send({ email: "not-an-email", password: "secure-password-123" });
      expect(res.status).toBe(400);
    });

    it("normalizes email to lowercase", async () => {
      const res = await request(server).post("/api/auth/register")
        .send({ email: "MixedCase@Example.COM", password: "secure-password-123" });
      expect(res.status).toBe(201);
      expect(res.body.email).toBe("mixedcase@example.com");
    });

    it("new user gets auditor role not admin", async () => {
      const res = await request(server).post("/api/auth/register")
        .send({ email: "auditor-role@example.com", password: "secure-password-123" });
      expect(res.status).toBe(201);
      expect(res.body.roles).toEqual(["auditor"]);
      expect(res.body.roles).not.toContain("admin",);
      auditorRoleSub = res.body.sub;
    });

    it("stores password only as scrypt hash", async () => {
      const user = mocks.state!.users.find((u) => u.sub === auditorRoleSub);
      expect(user).toBeDefined();
      expect(user!.passwordHash).toMatch(/^scrypt\$/);
      expect(user!.passwordHash).not.toContain("secure-password-123");
    });
  });

  describe("POST /api/auth/login local", () => {
    let savedJwt: string;
    let localSub: string;
    beforeAll(async () => {
      const reg = await request(server).post("/api/auth/register")
        .send({ email: "localuser@example.com", password: "correct-password-123" });
      localSub = reg.body.sub;
    });

    it("email + password correct -> 200 + cookie", async () => {
      const res = await request(server).post("/api/auth/login")
        .send({ email: "localuser@example.com", password: "correct-password-123" });
      expect(res.status).toBe(200);
      expect(res.body.sub).toBe(localSub);
      expect(res.body.roles).toEqual(["auditor"]);
      expect(res.headers["set-cookie"]).toBeDefined();
      expect(res.body.password).toBeUndefined();
      expect(res.body.passwordHash).toBeUndefined();
      savedJwt = extractJwt(res.headers["set-cookie"]);

      // last_login_at se actualiza tras el login exitoso
      const user = mocks.state!.users.find((u) => u.sub === localSub);
      expect(user!.lastLoginAt).toBeInstanceOf(Date);
    });

    it("incorrect password -> 401 and last_login_at unchanged", async () => {
      const before = mocks.state!.users.find((u) => u.sub === localSub)!.lastLoginAt;
      const res = await request(server).post("/api/auth/login")
        .send({ email: "localuser@example.com", password: "wrong-password-456" });
      expect(res.status).toBe(401);
      const after = mocks.state!.users.find((u) => u.sub === localSub)!.lastLoginAt;
      expect(after).toBe(before);
    });

    it("non-existent email -> 401", async () => {
      const res = await request(server).post("/api/auth/login")
        .send({ email: "nonexistent@example.com", password: "some-password-123" });
      expect(res.status).toBe(401);
    });

    it("user without password -> 401", async () => {
      const res = await request(server).post("/api/auth/login")
        .send({ email: "admin@local", password: "any-password-123" });
      expect(res.status).toBe(401);
    });

    it("JWT contains jti", async () => {
      // Reutiliza el JWT del login exitoso: no consume otro intento del limiter.
      const parts = savedJwt.split(".");
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      expect(payload.jti).toBeDefined();
      expect(typeof payload.jti).toBe("string");
    });
  });

  describe("Bootstrap compatibility", () => {
    it("bootstrap login still works", async () => {
      const res = await request(server).post("/api/auth/login")
        .send({ token: "bootstrap-token-for-tests-only" });
      expect(res.status).toBe(200);
      expect(res.body.sub).toBe("bootstrap-admin");
      expect(res.body.roles).toEqual(["admin"]);
    });

    it("auditor cannot access admin endpoints", async () => {
      await request(server).post("/api/auth/register")
        .send({ email: "auditor-only@example.com", password: "secure-password-123" });
      const login = await request(server).post("/api/auth/login")
        .send({ email: "auditor-only@example.com", password: "secure-password-123" });
      const jwt = extractJwt(login.headers["set-cookie"]);
      const res = await request(server).post("/api/reports")
        .set("Authorization", `Bearer ${jwt}`)
        .send({ name: "x", period: "last_30d" });
      expect(res.status).toBe(403);
    });
  });
});
