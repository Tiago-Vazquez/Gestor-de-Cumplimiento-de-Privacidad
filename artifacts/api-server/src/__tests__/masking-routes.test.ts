import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { Source } from "@workspace/db";
import app from "../app";
import type { MockState } from "./mock-repos";

// Mismo convenio que privacy-routes.test.ts / compliance-routes.test.ts:
// auth desactivada (el middleware global inyecta identidad admin simulada) y
// capa de repositorios sustituida por el stub in-memory antes de cargar `app`;
// PostgreSQL nunca se toca. El espejo del mock usa el masker REAL (M5.b) y
// replica EXACTAMENTE los límites y códigos de error del repo real.
process.env.AUTH_DISABLED = "true";

const mocks = vi.hoisted(() => ({ state: undefined as MockState | undefined }));

function state(): MockState {
  if (!mocks.state) throw new Error("mock repos not initialized");
  return mocks.state;
}

vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  const created = createMockRepos();
  mocks.state = created.state;
  return { repos: created.repos };
});

vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn() },
}));

function maskingActivityCount(): number {
  return state().activity.filter((a) => a.type === "masking").length;
}

/** Config de conexión mínima (nunca se usa: el mock no abre sockets). */
const MOCK_CONFIG = {
  host: "db.internal",
  port: 5432,
  database: "app",
  user: "reader",
  password: "unused-in-mock",
  sslMode: "require",
} as unknown as Source["connectionConfig"];

/** El espejo del mock replica al repo real: sin connectionConfig → job
 * `failed` con source_not_configured. Este helper habilita la conexión
 * para los caminos de éxito y devuelve la función de restauración. */
function enableConnection(sourceId: string): () => void {
  const source = state().sources.find((s) => s.id === sourceId)!;
  const original = source.connectionConfig;
  source.connectionConfig = MOCK_CONFIG;
  return () => {
    source.connectionConfig = original;
  };
}

describe("Masking jobs routes", () => {
  let server: ReturnType<Express["listen"]>;

  beforeAll(() => {
    server = app.listen(0);
  });

  afterAll(() => {
    server.close();
  });

  describe("POST /api/masking/jobs", () => {
    it("crea el job síncronamente y responde 201 con status=ready sin dataset", async () => {
      const restore = enableConnection("src-001");
      try {
        const res = await request(server)
          .post("/api/masking/jobs")
          .send({ sourceId: "src-001", fields: ["email", "phone"] });
        expect(res.status).toBe(201);
        expect(res.body.sourceId).toBe("src-001");
        expect(res.body.status).toBe("ready");
        expect(res.body.error).toBeNull();
        expect(res.body.completedAt).toBeTruthy();
        expect(res.body.records).toBeGreaterThan(0);
        // El dataset NUNCA sale en la respuesta del POST.
        expect(res.body).not.toHaveProperty("dataset");
      } finally {
        restore();
      }
    });

    it("capa los registros en MAX_MASKING_RECORDS (1000)", async () => {
      const source = state().sources.find((s) => s.id === "src-001")!;
      const original = source.records;
      source.records = 5000;
      const restore = enableConnection("src-001");
      try {
        const res = await request(server)
          .post("/api/masking/jobs")
          .send({ sourceId: "src-001", fields: ["email"] });
        expect(res.status).toBe(201);
        expect(res.body.records).toBe(1000);
      } finally {
        restore();
        source.records = original;
      }
    });

    it("rechaza campos no soportados con 400 problem+json", async () => {
      const res = await request(server)
        .post("/api/masking/jobs")
        .send({ sourceId: "src-001", fields: ["email", "password"] });
      expect(res.status).toBe(400);
      expect(res.body.title).toBe("Bad Request");
      expect(res.body.detail).toContain("password");
    });

    it("rechaza body sin campos con 400", async () => {
      const res = await request(server)
        .post("/api/masking/jobs")
        .send({ sourceId: "src-001", fields: [] });
      expect(res.status).toBe(400);
      expect(res.body.title).toBe("Bad Request");
    });

    it("fuente inexistente → 404 problem+json", async () => {
      const res = await request(server)
        .post("/api/masking/jobs")
        .send({ sourceId: "src-404", fields: ["email"] });
      expect(res.status).toBe(404);
      expect(res.body.title).toBe("Not Found");
    });

    it("fallo de conexión → 201 con job `failed` auditable, SIN dataset ni actividad", async () => {
      const source = state().sources.find((s) => s.id === "src-002")!;
      const original = source.name;
      source.name = "Unreachable PostgreSQL";
      const before = maskingActivityCount();
      try {
        const res = await request(server)
          .post("/api/masking/jobs")
          .send({ sourceId: "src-002", fields: ["email"] });
        expect(res.status).toBe(201);
        expect(res.body.status).toBe("failed");
        expect(res.body.error).toBe("source_unreachable");
        expect(res.body.records).toBe(0);
        expect(res.body).not.toHaveProperty("dataset");
        // Sin persistencia parcial: la fila fallida no tiene dataset.
        const failed = state().maskingJobs!.find((j) => j.id === res.body.id)!;
        expect(failed.dataset).toBeNull();
        // Sin actividad `masking` en fallo.
        expect(maskingActivityCount()).toBe(before);
      } finally {
        source.name = original;
      }
    });

    it("dataset mayor que ~2 MB → job `failed` con dataset_too_large", async () => {
      const source = state().sources.find((s) => s.id === "src-003")!;
      const original = source.name;
      source.name = "Oversized PostgreSQL";
      const restore = enableConnection("src-003");
      try {
        const res = await request(server)
          .post("/api/masking/jobs")
          .send({ sourceId: "src-003", fields: ["email"] });
        expect(res.status).toBe(201);
        expect(res.body.status).toBe("failed");
        expect(res.body.error).toBe("dataset_too_large");
      } finally {
        restore();
        source.name = original;
      }
    });

    it("registra actividad `masking` solo en éxito, sin PII ni secretos", async () => {
      const before = maskingActivityCount();
      const restore = enableConnection("src-001");
      try {
        const ok = await request(server)
          .post("/api/masking/jobs")
          .send({ sourceId: "src-001", fields: ["national_id"] });
        expect(ok.status).toBe(201);
        expect(ok.body.status).toBe("ready");
        expect(maskingActivityCount()).toBe(before + 1);
        const activity = state().activity[0]!;
        expect(activity.type).toBe("masking");
        // La descripción no contiene PII original ni connectionConfig.
        expect(activity.description).not.toContain("@demo.com");
        expect(JSON.stringify(activity)).not.toContain("connectionConfig");
      } finally {
        restore();
      }
    });
  });
});
