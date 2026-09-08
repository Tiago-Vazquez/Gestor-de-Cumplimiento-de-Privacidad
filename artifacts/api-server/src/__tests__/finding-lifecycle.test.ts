/**
 * FASE 7.2.1 (M1) — Tests del finding lifecycle (modulo puro).
 * Cubre: nuevo / persistente / mezcla / resolved por ausencia (solo completed)
 * / no-resolve en failed-cancelled / reopen de resolved / firstSeen estable /
 * lastSeen actualizado / atomicidad / concurrencia upsert / in_review.
 */
import { describe, expect, it } from "vitest";
import {
  computeFingerprint,
  planFindingLifecycle,
  type Detection,
  type ExistingFindingLike,
} from "../services/finding-lifecycle";

const detection = (o: Partial<Detection> = {}): Detection => ({
  location: "users.email",
  dataType: "email",
  severity: "high",
  records: 42,
  sample: "a***@example.com",
  regulation: "GDPR Art. 32",
  recommendation: "Cifrar",
  title: "Email detectado",
  ...o,
});

const existing = (o: Partial<ExistingFindingLike> = {}): ExistingFindingLike => ({
  id: "f-1",
  status: "open",
  fingerprint: computeFingerprint({ sourceId: "src-1", location: "users.email", dataType: "email" }),
  ...o,
});

const atLater = new Date("2026-08-02T10:00:00.000Z");
const fpEmail = () => computeFingerprint({ sourceId: "src-1", location: "users.email", dataType: "email" });

function plan(o: Partial<Parameters<typeof planFindingLifecycle>[0]> = {}) {
  return planFindingLifecycle({
    sourceId: "src-1",
    scanId: "scan-2",
    at: atLater,
    detections: o.detections ?? [detection()],
    existingByFingerprint: o.existingByFingerprint ?? new Map(),
    activeForSource: o.activeForSource ?? [],
    reconcileAbsence: o.reconcileAbsence ?? true,
  });
}

describe("computeFingerprint", () => {
  it("determinista y normalizacion de case/espacios", () => {
    expect(computeFingerprint({ sourceId: "src-1", location: "  Users.EMAIL ", dataType: " EMAIL " }))
      .toBe(computeFingerprint({ sourceId: "src-1", location: "users.email", dataType: "email" }));
  });

  it("escapa '|' y '\\' para evitar colisiones de delimitador", () => {
    const pipe = computeFingerprint({ sourceId: "src-1", location: "a|b", dataType: "email" });
    const backslash = computeFingerprint({ sourceId: "src-1", location: "a\\b", dataType: "email" });
    expect(pipe).not.toBe(computeFingerprint({ sourceId: "src-1", location: "a", dataType: "b|email" }));
    expect(backslash).not.toBe(computeFingerprint({ sourceId: "src-1", location: "ab", dataType: "email" }));
  });

  it("un dataType distinto en la misma celda produce otro fingerprint", () => {
    expect(computeFingerprint({ sourceId: "src-1", location: "users.contact", dataType: "email" }))
      .not.toBe(computeFingerprint({ sourceId: "src-1", location: "users.contact", dataType: "phone" }));
  });
});
describe("planFindingLifecycle", () => {
  it("1. finding nuevo -> insert (fingerprint presente, createdCount=1)", () => {
    const r = plan({ existingByFingerprint: new Map() });
    expect(r.toInsert).toHaveLength(1);
    expect(r.toInsert[0].fingerprint).toBe(fpEmail());
    expect(r.toUpdate).toHaveLength(0);
    expect(r.createdCount).toBe(1);
  });

  it("2. mismo fingerprint en segundo scan -> persistente (update, sin duplicado)", () => {
    const r = plan({ existingByFingerprint: new Map([[fpEmail(), existing({ id: "f-1" })]]) });
    expect(r.toInsert).toHaveLength(0);
    expect(r.toUpdate).toHaveLength(1);
    expect(r.toUpdate[0].findingId).toBe("f-1");
    expect(r.toUpdate[0].lastSeenScanId).toBe("scan-2");
    expect(r.createdCount).toBe(0);
  });

  it("3. mezcla de nuevos + existentes", () => {
    const r = plan({
      detections: [detection(), detection({ location: "users.phone", dataType: "phone", title: "Phone" })],
      existingByFingerprint: new Map([[fpEmail(), existing({ id: "f-email" })]]),
    });
    expect(r.toInsert).toHaveLength(1);
    expect(r.toUpdate).toHaveLength(1);
    expect(r.createdCount).toBe(1);
  });

  it("4. ausente en scan completed -> resolved", () => {
    const gone = existing({ id: "f-gone", fingerprint: computeFingerprint({ sourceId: "src-1", location: "old.gone", dataType: "email" }) });
    expect(plan({ activeForSource: [gone] }).toResolveIds).toContain("f-gone");
  });

  it("5. ausente en scan no-completed (failed/cancelled) -> NO resolved", () => {
    const gone = existing({ id: "f-gone", fingerprint: computeFingerprint({ sourceId: "src-1", location: "old.gone", dataType: "email" }) });
    expect(plan({ activeForSource: [gone], reconcileAbsence: false }).toResolveIds).toHaveLength(0);
  });

  it("6. resolved que reaparece -> open (mismo id)", () => {
    const r = plan({ existingByFingerprint: new Map([[fpEmail(), existing({ id: "f-x", status: "resolved" })]]) });
    expect(r.toInsert).toHaveLength(0);
    expect(r.toUpdate[0].nextStatus).toBe("open");
    expect(r.toUpdate[0].findingId).toBe("f-x");
  });

  it("7. firstSeenAt nunca aparece en el update (permanece estable)", () => {
    const r = plan({ existingByFingerprint: new Map([[fpEmail(), existing({ id: "f-1" })]]) });
    expect(r.toUpdate[0]).not.toHaveProperty("firstSeenAt");
  });

  it("8. lastSeenSeScanId se actualiza a la ultima observacion", () => {
    const r = plan({ existingByFingerprint: new Map([[fpEmail(), existing({ id: "f-1" })]]) });
    expect(r.toUpdate[0].lastSeenScanId).toBe("scan-2");
  });

  it("9. atomicidad: un finding detectado en el mismo plan no cae en toResolve", () => {
    const det = existing({ id: "f-det" });
    const r = plan({ existingByFingerprint: new Map([[fpEmail(), det]]), activeForSource: [det] });
    expect(r.toUpdate.some((u) => u.findingId === "f-det")).toBe(true);
    expect(r.toResolveIds).not.toContain("f-det");
  });

  it("10. concurrencia/upsert: segundo scan produce update, nunca 2 insert", () => {
    const first = plan({ existingByFingerprint: new Map() });
    expect(first.toInsert).toHaveLength(1);
    const second = plan({ existingByFingerprint: new Map([[fpEmail(), existing({ id: "f-1" })]]) });
    expect(second.toInsert).toHaveLength(0);
    expect(second.toUpdate).toHaveLength(1);
  });

  it("11. in_review que reaparece -> permanece in_review (politica explicita)", () => {
    const r = plan({ existingByFingerprint: new Map([[fpEmail(), existing({ id: "f-review", status: "in_review" })]]) });
    expect(r.toUpdate[0].nextStatus).toBe("in_review");
  });
});