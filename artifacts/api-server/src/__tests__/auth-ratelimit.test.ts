import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";

// Suite dedicada al rate limit de login. Usa AUTH desactivado para probar solo
// el rate limit, no el flujo completo de autenticación.
process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at least-32-characters!!";
process.env.AUTH_BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-only";

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

  it("allows first 5 login attempts and blocks the 6th with 429", async () => {
    // Los primeros 5 intentos se procesan normalmente (token incorrecto → 401)
    for (let i = 0; i < 5; i++) {
      const res = await request(server)
        .post("/api/auth/login")
        .send({ token: "wrong-token" });
      expect(res.status).toBe(401);
    }

    // El 6to intento excede el límite → 429
    const blocked = await request(server)
      .post("/api/auth/login")
      .send({ token: "wrong-token" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.status).toBe(429);
    expect(blocked.body.title).toBe("Too Many Requests");
  });
});
