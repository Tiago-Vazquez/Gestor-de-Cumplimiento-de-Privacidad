import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";

// Suite dedicada al rate limit de login local (email+password).
process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
// Los tests de rate limit necesitan controlar la IP para aislar buckets entre
// casos; habilitamos trust proxy explícitamente (ver F23-01).
process.env.TRUST_PROXY = "1";

vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(), end: vi.fn() } }));
vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  return { repos: createMockRepos().repos };
});

describe("POST /api/auth/login rate limit", () => {
  let server: ReturnType<Express["listen"]>;

  beforeAll(() => {
    server = app.listen(0);
  });

  afterAll(() => {
    server.close();
  });

  it("allows first 5 local login attempts and blocks the 6th with 429", async () => {
    // El limiter aplica al login local (email+password). Los intentos inválidos
    // (401) también cuentan: es la protección contra fuerza bruta.
    for (let i = 0; i < 5; i++) {
      const res = await request(server)
        .post("/api/auth/login")
        .send({ email: "bruteforce@example.com", password: "wrong-password" });
      expect(res.status).toBe(401);
    }

    // El 6to intento excede el límite → 429
    const blocked = await request(server)
      .post("/api/auth/login")
      .send({ email: "bruteforce@example.com", password: "wrong-password" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.status).toBe(429);
    expect(blocked.body.title).toBe("Too Many Requests");
  });
});
