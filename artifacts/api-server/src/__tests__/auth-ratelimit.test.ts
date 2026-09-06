import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";

// Suite dedicada al rate limit de login. Usa AUTH desactivado para probar solo
// el rate limit, no el flujo completo de autenticación.
process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.AUTH_BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-only";
process.env.AUTH_BOOTSTRAP_ENABLED = "true"; // 6.3B.15: bootstrap opt-in (ausente = off)

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

  it("does not count bootstrap token logins toward the local login limit", async () => {
    // El limiter local ya está agotado por el test anterior: un login local más
    // recibiría 429, pero el bootstrap usa su propio bucket (bootstrapLimiter).
    const res = await request(server)
      .post("/api/auth/login")
      .send({ token: "bootstrap-token-for-tests-only" });
    expect(res.status).toBe(200);
    expect(res.body.sub).toBe("bootstrap-admin");
  });

  // Fase 6.3B.9: bootstrapLimiter dedicado (5 intentos / 15 min / IP).
  // Cada test usa una IP distinta vía X-Forwarded-For (trust proxy = 1) para
  // que los buckets sean herméticos entre tests.
  const ip = (suffix: string) => `203.0.113.${suffix}`;

  it("blocks bootstrap token logins after 5 attempts with 429", async () => {
    const bootstrapIp = ip("10");
    // Primeros 5 intentos bootstrap desde esa IP → 200 (bucket dedicado).
    for (let i = 0; i < 5; i++) {
      const res = await request(server)
        .post("/api/auth/login")
        .set("X-Forwarded-For", bootstrapIp)
        .send({ token: "bootstrap-token-for-tests-only" });
      expect(res.status).toBe(200);
    }

    // El 6to intento excede el límite del bootstrapLimiter → 429.
    const blocked = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", bootstrapIp)
      .send({ token: "bootstrap-token-for-tests-only" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.status).toBe(429);
    expect(blocked.body.title).toBe("Too Many Requests");
    expect(blocked.body.detail).toContain("bootstrap login attempts");
  });

  it("exhausting the bootstrap bucket does not affect local login", async () => {
    const sharedIp = ip("11");
    // Agotar el bucket bootstrap de esa IP.
    for (let i = 0; i < 5; i++) {
      await request(server)
        .post("/api/auth/login")
        .set("X-Forwarded-For", sharedIp)
        .send({ token: "bootstrap-token-for-tests-only" });
    }
    const blockedBootstrap = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", sharedIp)
      .send({ token: "bootstrap-token-for-tests-only" });
    expect(blockedBootstrap.status).toBe(429);

    // Un login local desde la MISMA IP sigue pasando el rate limit
    // (401 = credenciales inválidas, no 429): buckets independientes.
    const local = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", sharedIp)
      .send({ email: "someone@example.com", password: "wrong-password" });
    expect(local.status).toBe(401);
  });

  it("exhausting the local login bucket does not affect bootstrap", async () => {
    const sharedIp = ip("12");
    // Agotar el bucket de login local de esa IP (5/15 min).
    for (let i = 0; i < 5; i++) {
      const res = await request(server)
        .post("/api/auth/login")
        .set("X-Forwarded-For", sharedIp)
        .send({ email: "someone@example.com", password: "wrong-password" });
      expect(res.status).toBe(401);
    }
    const blockedLocal = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", sharedIp)
      .send({ email: "someone@example.com", password: "wrong-password" });
    expect(blockedLocal.status).toBe(429);
    expect(blockedLocal.body.detail).toContain("Too many login attempts");

    // El bootstrap desde la MISMA IP sigue funcionando: está exento del
    // loginLimiter y su bucket dedicado está intacto para esa IP.
    const boot = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", sharedIp)
      .send({ token: "bootstrap-token-for-tests-only" });
    expect(boot.status).toBe(200);
  });
});
