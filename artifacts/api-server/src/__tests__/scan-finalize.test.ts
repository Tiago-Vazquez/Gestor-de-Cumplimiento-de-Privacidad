/**
 * M35.0 — Scan state integrity.
 *
 * Regresiones del guard de `finalizeScan`: una finalización tardía de un scan
 * terminal (failed/completed) no debe aplicar findings ni métricas derivadas.
 * Se ejercita el espejo in-memory (mock-repos), que replica el guard del repo
 * real (`scans.repo.ts`).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MockState } from "./mock-repos";
import { repos } from "../repositories";

const mocks = vi.hoisted(() => ({
  state: undefined as MockState | undefined,
}));

vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn(), end: vi.fn() },
  pg: { Client: class MockClient {} },
}));

vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  const created = createMockRepos();
  mocks.state = created.state;
  return { repos: created.repos };
});

function state(): MockState {
  if (!mocks.state) throw new Error("mock repos not initialized");
  return mocks.state;
}

function addScan(
  id: string,
  sourceId: string,
  status: "running" | "completed" | "failed",
): void {
  state().scans.push({
    id,
    sourceId,
    status,
    startedAt: new Date("2026-08-01T00:00:00.000Z"),
    completedAt: status === "running" ? null : new Date("2026-08-01T00:05:00.000Z"),
    findingsCreated: 0,
    heartbeatAt: null,
    tablesScanned: 0,
    recordsRead: 0,
    cancelRequested: false,
  });
}

const detection = {
  location: "users.email",
  dataType: "email",
  severity: "high",
  records: 5,
  sample: "a***@example.com",
  regulation: "GDPR Art. 32",
  recommendation: "Cifrar",
  title: "Email detectado",
};

function finalize(scanId: string): Promise<void> {
  const source = state().sources.find((s) => s.id === "src-001")!;
  const rule = state().rules[0];
  return repos.scans.finalizeScan({
    scanId,
    sourceId: "src-001",
    sourceName: source.name,
    completedAt: new Date("2026-08-01T00:10:00.000Z"),
    findings: [detection],
    scannedTables: 7,
    recordsRead: 999,
    ruleDeltas: new Map([[rule.key, 5]]),
    reconcileAbsence: false,
  });
}

describe("finalizeScan state guard (M35.0)", () => {
  beforeEach(() => {
    state().scans = [];
    state().findings = [];
  });

  it("running → completed: aplica findings y métricas", async () => {
    addScan("scan-running", "src-001", "running");
    const findingsBefore = state().findings.length;

    await finalize("scan-running");

    const scan = state().scans.find((s) => s.id === "scan-running")!;
    expect(scan.status).toBe("completed");
    expect(scan.completedAt).not.toBeNull();
    expect(scan.findingsCreated).toBe(1);
    expect(state().findings.length).toBe(findingsBefore + 1);
  });

  it("failed → completed: bloqueado, sin efectos", async () => {
    addScan("scan-failed", "src-001", "failed");
    const scanBefore = state().scans.find((s) => s.id === "scan-failed")!;
    const source = state().sources.find((s) => s.id === "src-001")!;
    const rule = state().rules[0];
    const findingsBefore = state().findings.length;
    const tablesBefore = source.tables;
    const recordsBefore = source.records;
    const detectionsBefore = rule.detections;

    await finalize("scan-failed");

    const scan = state().scans.find((s) => s.id === "scan-failed")!;
    expect(scan.status).toBe("failed");
    expect(scan.completedAt).toEqual(scanBefore.completedAt);
    expect(scan.findingsCreated).toBe(0);
    expect(state().findings.length).toBe(findingsBefore);
    expect(source.tables).toBe(tablesBefore);
    expect(source.records).toBe(recordsBefore);
    expect(rule.detections).toBe(detectionsBefore);
  });

  it("completed → completed: no-op, sin efectos", async () => {
    addScan("scan-done", "src-001", "completed");
    const findingsBefore = state().findings.length;

    await finalize("scan-done");

    const scan = state().scans.find((s) => s.id === "scan-done")!;
    expect(scan.status).toBe("completed");
    expect(scan.findingsCreated).toBe(0);
    expect(state().findings.length).toBe(findingsBefore);
  });
});
