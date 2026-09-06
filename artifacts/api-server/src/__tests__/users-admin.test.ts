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

describe("Users admin API", () => {
  let server: ReturnType<Express["listen"]>;
  let adminJwt: string;
  let bootstrapSub: string;
  let auditorSub: string;

  beforeAll(async () => {
    server = app.listen(0);
    // Bootstrap opt-in habilitado arriba (AUTH_BOOTSTRAP_ENABLED=true, 6.3B.15):
    // crea bootstrap-admin con rol admin.
    const boot = await request(server).post("/api/auth/login")
      .send({ token: "bootstrap-token-for-tests-only" });
    expect(boot.status).toBe(200);
    adminJwt = extractJwt(boot.headers["set-cookie"]);
    bootstrapSub = boot.body.sub;
    // Un usuario auditor local.
    const reg = await request(server).post("/api/auth/register")
      .send({ email: "auditor@example.com", password: "secure-password-123" });
    auditorSub = reg.body.sub;
  });
  afterAll(() => { server.close(); });

  const admin = () => ({
  get: (url: string) => request(server).get(url).set("Authorization", `Bearer ${adminJwt}`),
  post: (url: string) => request(server).post(url).set("Authorization", `Bearer ${adminJwt}`),
  patch: (url: string) => request(server).patch(url).set("Authorization", `Bearer ${adminJwt}`),
});

  describe("Authorization", () => {
    it("unauthenticated -> 401", async () => {
      const res = await request(server).get("/api/users");
      expect(res.status).toBe(401);
    });
    it("auditor -> 403", async () => {
      const login = await request(server).post("/api/auth/login")
        .send({ email: "auditor@example.com", password: "secure-password-123" });
      const auditorJwt = extractJwt(login.headers["set-cookie"]);
      const res = await request(server).get("/api/users")
        .set("Authorization", `Bearer ${auditorJwt}`);
      expect(res.status).toBe(403);
    });
    it("admin (bootstrap legacy) -> 200", async () => {
      const res = await admin().get("/api/users");
      expect(res.status).toBe(200);
    });
  });

  describe("GET /users", () => {
    it("lists users with safe projection (no passwordHash)", async () => {
      const res = await admin().get("/api/users");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      for (const u of res.body) {
        expect(u.passwordHash).toBeUndefined();
        expect(u.sub).toBeDefined();
        expect(u.email).toBeDefined();
        expect(Array.isArray(u.roles)).toBe(true);
      }
      expect(res.body.some((u: { sub: string }) => u.sub === bootstrapSub)).toBe(true);
    });
  });

  describe("GET /users/:sub", () => {
    it("returns single user without credentials", async () => {
      const res = await admin().get(`/api/users/${bootstrapSub}`);
      expect(res.status).toBe(200);
      expect(res.body.email).toBe("admin@local");
      expect(res.body.passwordHash).toBeUndefined();
    });
    it("unknown sub -> 404", async () => {
      const res = await admin().get("/api/users/does-not-exist");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /users/:sub", () => {
    it("updates name and email", async () => {
      const res = await admin().patch(`/api/users/${auditorSub}`)
        .send({ name: "Auditor Uno", email: "auditor.renamed@example.com" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Auditor Uno");
      expect(res.body.email).toBe("auditor.renamed@example.com");
      expect(res.body.passwordHash).toBeUndefined();
    });
    it("invalid email -> 400", async () => {
      const res = await admin().patch(`/api/users/${auditorSub}`)
        .send({ email: "not-an-email" });
      expect(res.status).toBe(400);
    });
    it("duplicate email -> 409", async () => {
      const res = await admin().patch(`/api/users/${auditorSub}`)
        .send({ email: "admin@local" });
      expect(res.status).toBe(409);
    });
    it("ignores roles sent by client (never trusts client roles)", async () => {
      const res = await admin().patch(`/api/users/${auditorSub}`)
        .send({ name: "Still Auditor", roles: ["admin"] });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Still Auditor");
      expect(res.body.roles).toEqual(["auditor"]);
    });
    it("unknown user -> 404", async () => {
      const res = await admin().patch("/api/users/does-not-exist")
        .send({ name: "X" });
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /users/:sub/roles", () => {
    it("promotes auditor to admin", async () => {
      const res = await admin().patch(`/api/users/${auditorSub}/roles`)
        .send({ roles: ["admin"] });
      expect(res.status).toBe(200);
      expect(res.body.roles).toEqual(["admin"]);
    });
    it("demotes bootstrap-admin while another admin exists", async () => {
      const res = await admin().patch(`/api/users/${bootstrapSub}/roles`)
        .send({ roles: ["auditor"] });
      expect(res.status).toBe(200);
      expect(res.body.roles).toEqual(["auditor"]);

      // 6.3B.5c: el cambio efectivo de rol del bootstrap revocó SU propia
      // sesión (adminJwt ya no es válido, lo verifica Identity stability).
      // Re-autenticamos al otro admin (el auditor promovido en el test previo)
      // para continuar el resto de la suite.
      const fresh = await request(server).post("/api/auth/login")
        .send({ email: "auditor.renamed@example.com", password: "secure-password-123" });
      expect(fresh.status).toBe(200);
      adminJwt = extractJwt(fresh.headers["set-cookie"]);
    });
    it("rejects removing the last admin -> 403", async () => {
      const res = await admin().patch(`/api/users/${auditorSub}/roles`)
        .send({ roles: ["auditor"] });
      expect(res.status).toBe(403);
    });
    it("invalid roles -> 400", async () => {
      const res = await admin().patch(`/api/users/${auditorSub}/roles`)
        .send({ roles: ["superuser"] });
      expect(res.status).toBe(400);
    });
    it("restores both admins", async () => {
      await admin().patch(`/api/users/${auditorSub}/roles`).send({ roles: ["admin"] });
      const res = await admin().patch(`/api/users/${bootstrapSub}/roles`)
        .send({ roles: ["admin"] });
      expect(res.status).toBe(200);
      expect(res.body.roles).toEqual(["admin"]);
    });
  });

  describe("Identity stability", () => {
    it("registered sub is a UUID, independent of email", async () => {
      expect(auditorSub).toMatch(/^[0-9a-f-]{36}$/i);
      expect(auditorSub).not.toContain("auditor@example.com");
    });
    it("changing email does NOT change sub", async () => {
      const before = await admin().get(`/api/users/${auditorSub}`);
      const res = await admin().patch(`/api/users/${auditorSub}`)
        .send({ email: "moved@example.com" });
      expect(res.status).toBe(200);
      expect(res.body.sub).toBe(before.body.sub);
    });
    it("JWT uses the stable sub and /auth/me returns it", async () => {
      const login = await request(server).post("/api/auth/login")
        .send({ email: "moved@example.com", password: "secure-password-123" });
      expect(login.status).toBe(200);
      expect(login.body.sub).toBe(auditorSub);
      const jwt = extractJwt(login.headers["set-cookie"]);
      const payload = JSON.parse(
        Buffer.from(jwt.split(".")[1], "base64url").toString(),
      );
      expect(payload.sub).toBe(auditorSub);
      expect(payload.jti).toBeDefined();
      const me = await request(server).get("/api/auth/me")
        .set("Authorization", `Bearer ${jwt}`);
      expect(me.status).toBe(200);
      expect(me.body.sub).toBe(auditorSub);
    });
  });
});