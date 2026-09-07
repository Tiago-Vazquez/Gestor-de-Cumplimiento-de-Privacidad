/**
 * FASE 7.0.4 — Recuperación de scans huérfanos (reaper).
 *
 * Unit: sweep de arranque (`before = bootStartedAt`) y sweep periódico
 * (`before = now - TTL`) sobre el mock de repositorios: estados terminales
 * intocados, frontera estricta, source eliminada y aislamiento de fallos.
 * El wiring de index.ts (listen + interval + shutdown) queda cubierto por
 * typecheck/build e inspección: la lógica íntegra vive en scan-recovery.ts
 * y en el repositorio.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MockState } from "./mock-repos";
import {
  recoverOrphanedScansAtBoot,
  recoverStaleRunningScans,
  SCAN_RUNNING_TTL_MS,
} from "../services/scan-recovery";

const mocks = vi.hoisted(() => ({
  state: undefined as MockState | undefined,
  repos: undefined as unknown,
}));

vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn(), end: vi.fn() },
  pg: { Client: class MockClient {} },
}));

vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  const created = createMockRepos();
  mocks.state = created.state;
  mocks.repos = created.repos;
  return { repos: created.repos };
});

function state(): MockState {
  if (!mocks.state) throw new Error("mock repos not initialized");
  return mocks.state;
}

function reposPatch(): {
  scans: { failRunningScansStartedBefore: (args: unknown) => Promise<unknown> };
} {
  if (!mocks.repos) throw new Error("mock repos not initialized");
  return mocks.repos as never;
}

function addScan(
  id: string,
  sourceId: string,
  status: "running" | "completed" | "failed",
  startedAt: Date,
): void {
  state().scans.push({ id, sourceId, status, startedAt, completedAt: null, findingsCreated: 0 });
}

describe("recoverOrphanedScansAtBoot — sweep de arranque (FASE 7.0.4)", () => {
  beforeEach(() => {
    state().scans = [];
    state().activity = [];
  });

  it("recupera todos los `running` anteriores al boot → failed(timeout) con actividad", async () => {
    const bootStartedAt = new Date();
    addScan("scan-b1", "src-001", "running", new Date(bootStartedAt.getTime() - 60_000));
    addScan("scan-b2", "src-002", "running", new Date(bootStartedAt.getTime() - 3_600_000));

    const recovered = await recoverOrphanedScansAtBoot(bootStartedAt);

    expect(recovered.map((scan) => scan.id).sort()).toEqual(["scan-b1", "scan-b2"]);
    for (const scan of state().scans) {
      expect(scan.status).toBe("failed");
      expect(scan.completedAt).not.toBeNull();
    }
    expect(state().activity.filter((event) => event.title === "Escaneo fallido")).toHaveLength(2);
  });

  it("un `running` creado después del boot permanece running (AJUSTE 1)", async () => {
    const bootStartedAt = new Date();
    addScan("scan-new", "src-001", "running", new Date(bootStartedAt.getTime() + 1_000));

    const recovered = await recoverOrphanedScansAtBoot(bootStartedAt);

    expect(recovered).toEqual([]);
    expect(state().scans[0]?.status).toBe("running");
    expect(state().scans[0]?.completedAt).toBeNull();
  });

  it("`completed` y `failed` nunca se tocan", async () => {
    const bootStartedAt = new Date();
    addScan("scan-c1", "src-001", "completed", new Date(bootStartedAt.getTime() - 60_000));
    addScan("scan-f1", "src-001", "failed", new Date(bootStartedAt.getTime() - 60_000));

    const recovered = await recoverOrphanedScansAtBoot(bootStartedAt);

    expect(recovered).toEqual([]);
    expect(state().scans.find((scan) => scan.id === "scan-c1")?.status).toBe("completed");
    expect(state().scans.find((scan) => scan.id === "scan-f1")?.status).toBe("failed");
  });

  it("frontera exacta: startedAt == bootStartedAt → NO tocado (comparación estricta)", async () => {
    const bootStartedAt = new Date();
    addScan("scan-edge", "src-001", "running", bootStartedAt);

    const recovered = await recoverOrphanedScansAtBoot(bootStartedAt);

    expect(recovered).toEqual([]);
    expect(state().scans[0]?.status).toBe("running");
  });

  it("source eliminada → el scan igualmente queda failed, sin actividad", async () => {
    const bootStartedAt = new Date();
    addScan("scan-ghost", "src-inexistente", "running", new Date(bootStartedAt.getTime() - 60_000));

    const recovered = await recoverOrphanedScansAtBoot(bootStartedAt);

    expect(recovered).toHaveLength(1);
    expect(state().scans[0]?.status).toBe("failed");
    expect(state().activity).toHaveLength(0);
  });
});

describe("recoverStaleRunningScans — sweep periódico (FASE 7.0.4)", () => {
  beforeEach(() => {
    state().scans = [];
    state().activity = [];
  });

  it("recupera solo los `running` con startedAt < now - TTL", async () => {
    const now = new Date();
    addScan("scan-stale", "src-001", "running", new Date(now.getTime() - SCAN_RUNNING_TTL_MS - 1_000));
    addScan("scan-fresh", "src-001", "running", new Date(now.getTime() - 1_000));

    const recovered = await recoverStaleRunningScans(now);

    expect(recovered.map((scan) => scan.id)).toEqual(["scan-stale"]);
    expect(state().scans.find((scan) => scan.id === "scan-stale")?.status).toBe("failed");
    expect(state().scans.find((scan) => scan.id === "scan-fresh")?.status).toBe("running");
  });

  it("frontera exacta: startedAt == now - TTL → NO tocado", async () => {
    const now = new Date();
    addScan("scan-edge", "src-001", "running", new Date(now.getTime() - SCAN_RUNNING_TTL_MS));

    const recovered = await recoverStaleRunningScans(now);

    expect(recovered).toEqual([]);
    expect(state().scans[0]?.status).toBe("running");
  });

  it("usa el TTL correcto vía repositorio (spy) y nunca lanza si el repo falla", async () => {
    const now = new Date();
    const scansRepo = reposPatch().scans;
    const spy = vi.spyOn(scansRepo, "failRunningScansStartedBefore");

    await recoverStaleRunningScans(now);

    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0]?.[0] as { before: Date; reason: string };
    expect(args.reason).toBe("timeout");
    expect(args.before.getTime()).toBe(now.getTime() - SCAN_RUNNING_TTL_MS);
    spy.mockRestore();

    const failing = vi
      .spyOn(scansRepo, "failRunningScansStartedBefore")
      .mockRejectedValue(new Error("db down"));
    await expect(recoverStaleRunningScans(now)).resolves.toEqual([]);
    failing.mockRestore();
  });
});