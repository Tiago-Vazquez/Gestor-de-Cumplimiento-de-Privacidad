import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";

// Los tests HTTP que cubren la API funcionan con autenticación desactivada:
// la capa de auth se evalúa en cada request y en dev/tests inecta identidad
// admin simulada. El comportamiento real con JWT se cubre en auth.test.ts.
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

describe("Privacy routes", () => {
  let server: ReturnType<Express["listen"]>;

  beforeAll(() => {
    server = app.listen(0);
  });

  afterAll(() => {
    server.close();
  });

  describe("GET /api/dashboard", () => {
    it("returns 200 with dashboard summary", async () => {
      const res = await request(server).get("/api/dashboard");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        complianceScore: expect.any(Number),
        openFindings: expect.any(Number),
        criticalFindings: expect.any(Number),
        protectedRecords: expect.any(Number),
        monitoredSources: expect.any(Number),
        scanStatus: "monitoring",
      });
      expect(res.body.findingsBySeverity).toBeDefined();
    });
  });

  describe("GET /api/activity", () => {
    it("returns 200 with an array of activities", async () => {
      const res = await request(server).get("/api/activity");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("GET /api/findings", () => {
    it("returns 200 with an array of findings", async () => {
      const res = await request(server).get("/api/findings");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("filters by status when query param is provided", async () => {
      const res = await request(server).get("/api/findings?status=open");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      for (const finding of res.body) {
        expect(finding.status).toBe("open");
      }
    });
  });

  describe("PATCH /api/findings/:id", () => {
    it("returns 200 and updates the finding status", async () => {
      const res = await request(server)
        .patch("/api/findings/f-001")
        .send({ status: "in_review" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("in_review");
    });

    it("returns 404 for a non-existent finding", async () => {
      const res = await request(server)
        .patch("/api/findings/nonexistent")
        .send({ status: "resolved" });
      expect(res.status).toBe(404);
      expect(res.body.title).toBe("Not Found");
    });
  });

  describe("GET /api/sources", () => {
    it("returns 200 with an array of sources", async () => {
      const res = await request(server).get("/api/sources");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("GET /api/rules", () => {
    it("returns 200 with an array of rules", async () => {
      const res = await request(server).get("/api/rules");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("POST /api/scans", () => {
    it("returns 202 with a running scan for a valid source", async () => {
      const res = await request(server)
        .post("/api/scans")
        .send({ sourceId: "src-001" });
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        sourceId: "src-001",
        status: "running",
      });
      expect(res.body.id).toBeDefined();
      expect(res.body.startedAt).toBeDefined();
    });

    it("returns 404 for a non-existent source", async () => {
      const res = await request(server)
        .post("/api/scans")
        .send({ sourceId: "nonexistent" });
      expect(res.status).toBe(404);
      expect(res.body.title).toBe("Not Found");
    });
  });

  describe("GET /api/reports", () => {
    it("returns 200 with an array of reports", async () => {
      const res = await request(server).get("/api/reports");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("POST /api/reports", () => {
    it("returns 201 and creates a report", async () => {
      const res = await request(server)
        .post("/api/reports")
        .send({ name: "Test Report", period: "last_30d" });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: "Test Report",
        period: "last_30d",
        status: "ready",
      });
      expect(res.body.id).toBeDefined();
    });
  });

  describe("GET /api/reports/:id", () => {
    it("returns 200 and the report for a valid id", async () => {
      const createRes = await request(server)
        .post("/api/reports")
        .send({ name: "Fetch Me", period: "last_7d" });
      const id = createRes.body.id;

      const res = await request(server).get(`/api/reports/${id}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id, name: "Fetch Me", status: "ready" });
    });

    it("returns 404 for a non-existent report", async () => {
      const res = await request(server).get("/api/reports/nonexistent");
      expect(res.status).toBe(404);
      expect(res.body.title).toBe("Not Found");
    });
  });

  describe("GET /api/reports/:id/download", () => {
    it("returns 200 with Content-Disposition attachment header", async () => {
      const createRes = await request(server)
        .post("/api/reports")
        .send({ name: "Download Me", period: "last_30d" });
      const id = createRes.body.id;

      const res = await request(server).get(`/api/reports/${id}/download`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id, name: "Download Me" });
      expect(res.headers["content-disposition"]).toContain("attachment");
      expect(res.headers["content-disposition"]).toContain(`report-${id}.json`);
    });

    it("returns 404 for a non-existent report", async () => {
      const res = await request(server).get("/api/reports/nonexistent/download");
      expect(res.status).toBe(404);
      expect(res.body.title).toBe("Not Found");
    });
  });

  describe("POST /api/masking/preview", () => {
    it("returns 200 with masked rows for a valid source", async () => {
      const res = await request(server)
        .post("/api/masking/preview")
        .send({ sourceId: "src-001", fields: ["email", "phone"] });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        sourceId: "src-001",
        maskedFields: ["email", "phone"],
      });
      expect(Array.isArray(res.body.rows)).toBe(true);
    });

    it("returns 404 for a non-existent source", async () => {
      const res = await request(server)
        .post("/api/masking/preview")
        .send({ sourceId: "nonexistent", fields: ["email"] });
      expect(res.status).toBe(404);
      expect(res.body.title).toBe("Not Found");
    });
  });
});