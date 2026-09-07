import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Source } from "@workspace/db";
import {
  encryptConnectionConfig,
  decryptConnectionConfig,
  isScannable,
  type SourceConnectionConfig,
} from "../repositories/sources.repo";
import * as secretManager from "../lib/secret-manager";

/**
 * FASE 7.0.0 — Tests de sources: conexión cifrada, compatibilidad legacy.
 */

// Mock de @workspace/db para no requerir conexión real
vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn(), end: vi.fn() },
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
  },
}));

const VALID_KEY = "test-source-encryption-key-of-32-chars!!";

const sampleConfig: SourceConnectionConfig = {
  host: "db.example.com",
  port: 5432,
  database: "production",
  user: "scanner",
  password: "p@ssw0rd-ultra-secret",
  schema: "public",
};

describe("sources.repo: connection_config encryption", () => {
  const originalKey = process.env.SOURCE_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.SOURCE_ENCRYPTION_KEY = VALID_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.SOURCE_ENCRYPTION_KEY;
    } else {
      process.env.SOURCE_ENCRYPTION_KEY = originalKey;
    }
  });

  it("encryptConnectionConfig() → string base64 cifrado (no plaintext)", () => {
    const encrypted = encryptConnectionConfig(sampleConfig);
    expect(encrypted).not.toContain("p@ssw0rd-ultra-secret");
    expect(encrypted).not.toContain("db.example.com");
    // Formato esperado: iv:tag:ciphertext
    expect(encrypted.split(":")).toHaveLength(3);
  });

  it("decryptConnectionConfig() → roundtrip completo", () => {
    const source: Source = {
      id: "src-1",
      name: "Test DB",
      kind: "postgresql",
      environment: "staging",
      status: "active",
      lastScanAt: null,
      tables: 0,
      records: 0,
      connectionConfig: encryptConnectionConfig(sampleConfig),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const decrypted = decryptConnectionConfig(source);
    expect(decrypted).toEqual(sampleConfig);
  });

  it("decryptConnectionConfig() → null para fuente legacy (sin config)", () => {
    const legacySource: Source = {
      id: "src-legacy",
      name: "Legacy Source",
      kind: "api",
      environment: "production",
      status: "active",
      lastScanAt: null,
      tables: 5,
      records: 1000,
      connectionConfig: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(decryptConnectionConfig(legacySource)).toBeNull();
  });

  it("decryptConnectionConfig() → null para configuración corrupta", () => {
    const corruptSource: Source = {
      id: "src-corrupt",
      name: "Corrupt Source",
      kind: "postgresql",
      environment: "staging",
      status: "active",
      lastScanAt: null,
      tables: 0,
      records: 0,
      connectionConfig: "not-valid-encrypted-data",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(decryptConnectionConfig(corruptSource)).toBeNull();
  });

  it("isScannable() → true cuando hay connectionConfig", () => {
    const source: Source = {
      id: "src-1",
      name: "Test",
      kind: "postgresql",
      environment: "staging",
      status: "active",
      lastScanAt: null,
      tables: 0,
      records: 0,
      connectionConfig: "iv:tag:ciphertext",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(isScannable(source)).toBe(true);
  });

  it("isScannable() → false para fuente legacy", () => {
    const legacySource: Source = {
      id: "src-legacy",
      name: "Legacy",
      kind: "api",
      environment: "production",
      status: "active",
      lastScanAt: null,
      tables: 5,
      records: 1000,
      connectionConfig: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(isScannable(legacySource)).toBe(false);
  });

  it("fail-closed: encryptConnectionConfig lanza error sin key", () => {
    delete process.env.SOURCE_ENCRYPTION_KEY;
    expect(() => encryptConnectionConfig(sampleConfig)).toThrow(/SOURCE_ENCRYPTION_KEY/);
  });
});

describe("sources.repo: security", () => {
  const originalKey = process.env.SOURCE_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.SOURCE_ENCRYPTION_KEY;
    } else {
      process.env.SOURCE_ENCRYPTION_KEY = originalKey;
    }
  });

  it("password nunca aparece en texto plano en connectionConfig cifrado", () => {
    process.env.SOURCE_ENCRYPTION_KEY = VALID_KEY;
    const encrypted = encryptConnectionConfig(sampleConfig);
    expect(encrypted).not.toContain(sampleConfig.password);
    expect(encrypted).not.toContain(sampleConfig.user);
    expect(encrypted).not.toContain(sampleConfig.host);
  });
});
