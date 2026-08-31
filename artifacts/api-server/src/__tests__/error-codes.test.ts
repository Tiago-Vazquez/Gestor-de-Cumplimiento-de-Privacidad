import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";

// Los tests HTTP nunca tocan PostgreSQL: se sustituye la capa completa de
// repositorios por el stub in-memory antes de cargar `app`, por lo que
// `@workspace/db` ni siquiera llega a importarse.
vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  return { repos: createMockRepos().repos };
});

describe("Error codes", () => {
  let server: ReturnType<Express["listen"]>;

  beforeAll(() => {
    server = app.listen(0);
  });

  afterAll(() => {
    server.close();
  });

  it("returns 400 problem+json for malformed JSON body", async () => {
    const res = await request(server)
      .post("/api/scans")
      .set("Content-Type", "application/json")
      .send('{"sourceId":');
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.body).toMatchObject({
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      detail: "Malformed request body",
    });
  });

  it("returns 413 for payload exceeding size limit", async () => {
    const bigPayload = "x".repeat(20_000);
    const res = await request(server)
      .post("/api/scans")
      .set("Content-Type", "application/json")
      .send(`{"sourceId":"${bigPayload}"}`);
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      title: "Payload Too Large",
      status: 413,
    });
  });

  it("returns 404 problem+json for unknown routes", async () => {
    const res = await request(server).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.body).toMatchObject({
      type: "about:blank",
      title: "Not Found",
      status: 404,
    });
  });

  it("returns 429 after exceeding rate limit for mutations", async () => {
    const sendRequest = () =>
      request(server)
        .post("/api/scans")
        .set("Content-Type", "application/json")
        .send('{"sourceId":"src-001"}');

    let lastStatus = 202;
    for (let i = 0; i < 35; i++) {
      const res = await sendRequest();
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});