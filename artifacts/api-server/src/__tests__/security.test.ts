import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";

// Los tests HTTP que cubren la API funcionan con autenticación desactivada.
process.env.AUTH_DISABLED = "true";

// Los tests HTTP nunca tocan PostgreSQL: se sustituye la capa completa de
// repositorios por el stub in-memory antes de cargar `app`, por lo que
// `@workspace/db` ni siquiera llega a importarse.
vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  return { repos: createMockRepos().repos };
});
vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn() },
}));

describe("Security middleware", () => {
  let server: ReturnType<Express["listen"]>;

  beforeAll(() => {
    server = app.listen(0);
  });

  afterAll(() => {
    server.close();
  });

  describe("Helmet headers", () => {
    it("includes security headers on responses", async () => {
      const res = await request(server).get("/api/healthz");
      expect(res.status).toBe(200);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["x-dns-prefetch-control"]).toBe("off");
    });
  });

  describe("CORS", () => {
    it("allows requests from an allowed origin", async () => {
      const res = await request(server)
        .get("/api/healthz")
        .set("Origin", "http://localhost:5173");
      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe(
        "http://localhost:5173",
      );
    });

    it("rejects requests from a disallowed origin", async () => {
      const res = await request(server)
        .get("/api/healthz")
        .set("Origin", "http://evil.example");
      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  describe("RateLimit headers", () => {
    it("includes RateLimit headers on responses", async () => {
      const res = await request(server).get("/api/dashboard");
      expect(res.status).toBe(200);
      expect(res.headers["ratelimit-limit"]).toBeDefined();
      expect(res.headers["ratelimit-remaining"]).toBeDefined();
      expect(res.headers["ratelimit-reset"]).toBeDefined();
    });
  });
});