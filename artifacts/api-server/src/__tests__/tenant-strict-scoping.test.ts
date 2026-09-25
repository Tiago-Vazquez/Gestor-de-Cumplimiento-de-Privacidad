import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import type { MockState } from "./mock-repos";
import { tenantScopeStrict } from "../repositories/tenant";

/**
 * M21.5 — scoping estrictamente tenant-aware (retiro del fallback `IS NULL`).
 *
 * Verifica:
 * - `tenant.ts` solo expone `tenantScopeStrict` (igualdad exacta, sin `IS NULL`).
 * - Un usuario SIN organización activa recibe 403 en lecturas tenant-scoped
 *   (fail-closed), nunca listas vacías ni resultados parciales.
 */
const tenantSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../repositories/tenant.ts"),
  "utf8",
);

process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.AUTH_REGISTRATION_ENABLED = "true";

const mocks = vi.hoisted(() => ({ state: undefined as MockState | undefined }));
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(), end: vi.fn() } }));
vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  const created = createMockRepos();
  mocks.state = created.state;
  return { repos: created.repos };
});

function cookieOf(res: { headers: { [k: string]: unknown } }): string {
  const set = res.headers["set-cookie"] as string[] | string | undefined;
  const arr = Array.isArray(set) ? set : set ? [set] : [];
  const hit = arr.find((c) => c.startsWith("session="));
  if (!hit) throw new Error("session cookie not found");
  return hit.split(";")[0];
}

describe("M21.5 — scoping estrictamente tenant-aware", () => {
  it("tenant.ts expone tenantScopeStrict y no usa el fallback IS NULL", () => {
    expect(tenantSrc).toContain("export function tenantScopeStrict");
    expect(tenantSrc).not.toContain("isNull");
    expect(tenantSrc).not.toContain("or(eq");
  });

  it("usuario sin organización activa → 403 en lecturas tenant-scoped", async () => {
    const server: ReturnType<Express["listen"]> = app.listen(0);
    try {
      await request(server)
        .post("/api/auth/register")
        .send({ email: "orgless-m215@example.com", password: "secure-password-123" });
      const login = await request(server)
        .post("/api/auth/login")
        .send({ email: "orgless-m215@example.com", password: "secure-password-123" });
      expect(login.status).toBe(200);
      const cookie = cookieOf(login);

      const reads = [
        "/api/dashboard",
        "/api/compliance",
        "/api/activity",
        "/api/findings",
        "/api/sources",
        "/api/scans",
        "/api/reports",
        "/api/masking/jobs",
      ];
      for (const path of reads) {
        const res = await request(server).get(path).set("Cookie", cookie);
        expect(res.status, `${path} debe ser 403 para usuario sin organización`).toBe(403);
      }
    } finally {
      server.close();
    }
  });

  it("M21.7 — tenantScopeStrict lanza con organizationId falsy (undefined/null/'')", () => {
    const column = {} as never;
    const expected = "tenantScopeStrict requires a non-empty organizationId";
    expect(() => tenantScopeStrict(column, undefined as unknown as string)).toThrow(expected);
    expect(() => tenantScopeStrict(column, null as unknown as string)).toThrow(expected);
    expect(() => tenantScopeStrict(column, "")).toThrow(expected);
  });

  it("M21.7 — los repos de negocio retiraron el fallback fail-open y los flujos internos son explícitos", () => {
    const read = (rel: string) =>
      readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), rel), "utf8");

    for (const name of [
      "activity.repo.ts",
      "audit-events.repo.ts",
      "compliance.repo.ts",
      "dashboard.repo.ts",
      "findings.repo.ts",
      "masking.repo.ts",
      "reports.repo.ts",
      "scan-schedules.repo.ts",
      "scans.repo.ts",
      "sources.repo.ts",
    ]) {
      const src = read(`../repositories/${name}`);
      expect(src, `${name} no debe conservar el fallback fail-open`).not.toContain(
        "tenantId ? tenantScopeStrict",
      );
    }

    // Los únicos caminos sin tenant son métodos internos con nombre explícito.
    expect(read("../repositories/scans.repo.ts")).toContain("startScanInternal");
    expect(read("../repositories/sources.repo.ts")).toContain("getByIdForScan");
    expect(read("../services/scanner.ts")).toContain("getByIdForScan");
    expect(read("../services/scan-scheduler.ts")).toContain("startScanInternal");
  });
});
