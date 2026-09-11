import { describe, expect, it, vi } from "vitest";

// Mismo patrón que compliance-repo.test.ts: el módulo `@workspace/db` exige
// DATABASE_URL al importarse, así que se sustituye por stubs antes de cargar
// masking.repo. Estos tests ejercitan la capa PURA del repositorio (validación
// de campos, límites de tamaño y clasificación de errores, verificando que
// nunca filtran secretos ni PII). El ciclo de vida completo (lectura de la
// fuente, masker, persistencia atómica) se cubre vía HTTP en
// masking-routes.test.ts con el espejo in-memory del mock.
vi.mock("@workspace/db", () => ({
  db: {},
  maskingJobsTable: {},
  sourcesTable: {},
  activityTable: {},
}));

import {
  assertMaskableFields,
  classifyMaskingError,
  datasetByteSize,
} from "../repositories/masking.repo";
import {
  MAX_MASKING_DATASET_BYTES,
  MAX_MASKING_RECORDS,
} from "../lib/masking-limits";

describe("assertMaskableFields", () => {
  it("acepta los 4 campos del catálogo M5.b y deduplica", () => {
    expect(assertMaskableFields(["email", "phone", "email"])).toEqual([
      "email",
      "phone",
    ]);
    expect(assertMaskableFields(["credit_card", "national_id"])).toEqual([
      "credit_card",
      "national_id",
    ]);
  });

  it("rechaza campos fuera del catálogo con 400 y los nombra (sin sugerencias de PII)", () => {
    let thrown: unknown;
    try {
      assertMaskableFields(["password"]);
      expect.unreachable();
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { status?: number }).status).toBe(400);
    try {
      assertMaskableFields(["email", "ssn", "password"]);
      expect.unreachable();
    } catch (err) {
      expect((err as { status?: number }).status).toBe(400);
      expect((err as Error).message).toContain("ssn");
      expect((err as Error).message).toContain("password");
    }
  });

  it("rechaza lista vacía con 400", () => {
    let thrown: unknown;
    try {
      assertMaskableFields([]);
      expect.unreachable();
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { status?: number }).status).toBe(400);
  });

  it("los espejos de límites coinciden con masking-limits (única fuente de verdad)", () => {
    expect(MAX_MASKING_RECORDS).toBe(1000);
    expect(MAX_MASKING_DATASET_BYTES).toBe(2_000_000);
  });
});

function badRequestShape(err: unknown): boolean {
  return err instanceof Error && (err as { status?: number }).status === 400;
}

describe("datasetByteSize", () => {
  it("mide el tamaño JSON serializado UTF-8", () => {
    const dataset = { fields: ["email"], rows: [{ email: "user0@demo.com" }] };
    expect(datasetByteSize(dataset)).toBe(
      Buffer.byteLength(JSON.stringify(dataset), "utf8"),
    );
  });

  it("un dataset sobre el límite ~2 MB lo excede (validación antes de persistir)", () => {
    const oversized = {
      fields: ["email"],
      rows: [{ email: "x".repeat(MAX_MASKING_DATASET_BYTES) }],
    };
    expect(datasetByteSize(oversized)).toBeGreaterThan(MAX_MASKING_DATASET_BYTES);
  });
});

describe("classifyMaskingError", () => {
  it("clasifica errores de conexión como source_unreachable", () => {
    expect(classifyMaskingError(new Error("ECONNREFUSED 10.0.0.5:5432"))).toBe(
      "source_unreachable",
    );
  });

  it("cualquier otro error cae en masking_failed SIN filtrar el mensaje original", () => {
    const secret = "server-password=hunter2";
    const code = classifyMaskingError(new Error(`boom: ${secret}`));
    expect(code).toBe("masking_failed");
    expect(code).not.toContain("hunter2");
  });
});
