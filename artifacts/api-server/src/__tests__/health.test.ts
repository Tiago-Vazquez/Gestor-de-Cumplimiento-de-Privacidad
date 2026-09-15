import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import { pool } from "@workspace/db";

const queryMock = vi.mocked(pool.query);

vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  return { repos: createMockRepos().repos };
});
vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn() },
}));

describe("GET /api/healthz (readiness)", () => {
  let server: ReturnType<Express["listen"]>;

  beforeAll(() => {
    server = app.listen(0);
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [{ "?column?": 1 }] } as never);
    delete process.env.HEALTHCHECK_DB;
  });

  it("returns 200 without touching the database when HEALTHCHECK_DB is unset", async () => {
    const res = await request(server).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns 200 and checks the database when HEALTHCHECK_DB=true", async () => {
    process.env.HEALTHCHECK_DB = "true";
    const res = await request(server).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when the database is unreachable", async () => {
    process.env.HEALTHCHECK_DB = "1";
    queryMock.mockRejectedValue(new Error("connection failed"));
    const res = await request(server).get("/api/healthz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("error");
  });
it("returns 200 on /api/livez without touching the database", async () => {
    // Ni siquiera con el chequeo de BD activado: liveness no depende de Postgres.
    process.env.HEALTHCHECK_DB = "true";
    const res = await request(server).get("/api/livez");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("keeps /api/livez and /api/readyz public (no auth applied)", async () => {
    const livez = await request(server).get("/api/livez");
    const readyz = await request(server).get("/api/readyz");
    expect(livez.status).toBe(200);
    expect(readyz.status).toBe(200);
  });

  it("returns 200 on /api/readyz and checks the database", async () => {
    const res = await request(server).get("/api/readyz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("returns 503 on /api/readyz when the database check fails", async () => {
    queryMock.mockRejectedValue(new Error("connection failed"));
    const res = await request(server).get("/api/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("error");
  });

  it("keeps the probes unthrottled by the general rate limit", async () => {
    // El límite general por defecto es 100: sin la exención esta ráfaga
    // devolvería 429 y el orquestador marcaría como caído un proceso sano.
    let status = 200;
    for (let i = 0; i < 101 && status === 200; i++) {
      const res = await request(server).get("/api/livez");
      status = res.status;
    }
    expect(status).toBe(200);
  });
});