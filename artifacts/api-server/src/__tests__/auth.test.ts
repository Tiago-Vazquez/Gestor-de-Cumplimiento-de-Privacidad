import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import { signToken } from "../auth/tokens";

// Suite con autenticación REAL: activamos JWT para validar el middleware.
process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";

vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(), end: vi.fn() } }));
vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  return { repos: createMockRepos().repos };
});

describe("Auth middleware (JWT)", () => {
  let server: ReturnType<Express["listen"]>;
  let adminToken: string;
  let auditorToken: string;

  beforeAll(async () => {
    server = app.listen(0);
    adminToken = await signToken({
      sub: "admin-1",
      email: "admin@test.local",
      name: "Admin",
      roles: ["admin"],
    });
    auditorToken = await signToken({
      sub: "auditor-1",
      email: "auditor@test.local",
      name: "Auditor",
      roles: ["auditor"],
    });
  });

  afterAll(() => {
    server.close();
  });

  it("returns 401 + WWW-Authenticate when no token is provided", async () => {
    const res = await request(server).get("/api/dashboard");
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
    expect(res.body.status).toBe(401);
  });

  it("returns 401 for an invalid token", async () => {
    const res = await request(server)
      .get("/api/dashboard")
      .set("Authorization", "Bearer not-a-valid-jwt");
    expect(res.status).toBe(401);
  });

  it("returns 200 for an auditor on a read endpoint", async () => {
    const res = await request(server)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${auditorToken}`);
    expect(res.status).toBe(200);
  });

  it("returns 403 for an auditor on an admin-only mutation", async () => {
    const res = await request(server)
      .post("/api/reports")
      .set("Authorization", `Bearer ${auditorToken}`)
      .send({ name: "x", period: "last_30d" });
    expect(res.status).toBe(403);
    expect(res.body.status).toBe(403);
  });

  it("returns 201 for an admin on an admin-only mutation", async () => {
    const res = await request(server)
      .post("/api/reports")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Admin Report", period: "last_30d" });
    expect(res.status).toBe(201);
  });

  it("keeps /api/healthz public without a token", async () => {
    const res = await request(server).get("/api/healthz");
    expect(res.status).toBe(200);
  });
});