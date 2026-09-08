/**
 * FASE 7.2.1 (M1) — Finding lifecycle.
 *
 * Lógica PURA y determinista del ciclo de vida histórico de un finding. No
 * importa la BD: recibe los hallazgos detectados por el scanner y los hallazgos
 * ya persistidos, y devuelve el plan de escrituras (inserts / updates /
 * resoluciones). La capa de repositorio ejecuta ese plan DENTRO de la única
 * transacción de `finalizeScan`.
 *
 * Semánticas garantizadas (documentadas en lib/db/src/schema/findings.ts):
 * - `scanId` NUNCA se reasigna: conserva "scan que creó el hallazgo".
 *   El último scan que lo re-detectó se registra en `lastSeenScanId`.
 * - `fingerprint` normaliza y escapa cada componente (lower+trim, `\`→`\\` y
 *   `|`→`\|`) antes de unirlos con `|`. Es el MISMO algoritmo que usa la
 *   migración 0007 para el backfill, por lo que nunca divergen.
 * - `firstSeenAt` se fija en el INSERT y no se toca jamás.
 * - `lastSeenAt` se actualiza en cada re-detección.
 * - Reconciliación por ausencia SOLO cuando el scan terminó `completed` CON
 *   cobertura completa (`reconcileAbsence`). En scan failed/cancelled/timeout
 *   o incompleto NUNCA se resuelve por ausencia.
 * - Transición de estado en re-detección: `resolved` → `open`;
 *   `in_review` se CONSERVA (la revisión manual sigue en curso y la re-detección
 *   la confirma, no la revierte). Cualquier otro estado se conserva intacto.
 */

/** Detección producida por el scanner (payload de `finalizeScan`). */
export interface Detection {
  location: string;
  dataType: string;
  severity: string;
  records: number;
  sample: string;
  regulation: string;
  recommendation: string;
  title: string;
}

/** Subconjunto de un finding persistido que el planner necesita. */
export interface ExistingFindingLike {
  id: string;
  status: string;
  fingerprint: string | null;
}

/** Estado transitorio para un UPDATE (campos variables + tracking). */
export interface FindingUpdate {
  findingId: string;
  nextStatus: string;
  severity: string;
  records: number;
  sample: string;
  regulation: string;
  recommendation: string;
  title: string;
  lastSeenScanId: string;
}

export interface FindingInsert extends Detection {
  fingerprint: string;
}

export interface FindingLifecyclePlan {
  toInsert: FindingInsert[];
  toUpdate: FindingUpdate[];
  /** IDs de findings activos ausentes en un scan completed con cobertura completa. */
  toResolveIds: string[];
  /** Cantidad de findings NUEVOS (filas insertadas) — alimenta `scans.findingsCreated`. */
  createdCount: number;
}

/** Normaliza un componente del fingerprint: lower+trim y escapa delimitadores. */
function normalizePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

/**
 * Fingerprint determinista y normalizado: `sourceId | location | dataType`.
 *
 * Hoy el catálogo ejecutable del scanner tiene 4 reglas con `dataType` únicos
 * (BUILT_IN_RULES: email/phone/national_id/credit_card) y ninguna regla distinta
 * puede emitir el mismo dataType, por lo que el triple identifica de forma
 * estable un finding lógico producido por el scanner. Si algún día el catálogo
 * incluyera dos reglas con el mismo `dataType`, el triple dejaría de ser
 * suficiente y habría que re-verificar antes de avanzar.
 */
export function computeFingerprint(input: {
  sourceId: string;
  location: string;
  dataType: string;
}): string {
  return `${normalizePart(input.sourceId)}|${normalizePart(input.location)}|${normalizePart(input.dataType)}`;
}

export interface PlanFindingLifecycleInput {
  sourceId: string;
  scanId: string;
  at: Date;
  detections: Detection[];
  /** findings canónicos (superseded=false) por fingerprint — incluye resolved para reabrir. */
  existingByFingerprint: Map<string, ExistingFindingLike>;
  /** findings ACTIVOS (status <> resolved) de esta fuente (canónicos). */
  activeForSource: ExistingFindingLike[];
  /** true SOLO si el scan terminó completed con cobertura completa (todas las tablas, sin tope de findings). */
  reconcileAbsence: boolean;
}

export function planFindingLifecycle(input: PlanFindingLifecycleInput): FindingLifecyclePlan {
  const toInsert: FindingInsert[] = [];
  const toUpdate: FindingUpdate[] = [];
  const toResolveIds: string[] = [];
  const detectedFingerprints = new Set<string>();

  for (const detection of input.detections) {
    const fingerprint = computeFingerprint({
      sourceId: input.sourceId,
      location: detection.location,
      dataType: detection.dataType,
    });
    detectedFingerprints.add(fingerprint);

    const existing = input.existingByFingerprint.get(fingerprint);

    if (!existing) {
      toInsert.push({ ...detection, fingerprint });
      continue;
    }

    // Persistente (o resolved que reaparece, o in_review que reaparece).
    // `scanId` NO se toca nunca aquí: la identidad de origen se preserva.
    const nextStatus = existing.status === "resolved" ? "open" : existing.status;
    toUpdate.push({
      findingId: existing.id,
      nextStatus,
      severity: detection.severity,
      records: detection.records,
      sample: detection.sample,
      regulation: detection.regulation,
      recommendation: detection.recommendation,
      title: detection.title,
      lastSeenScanId: input.scanId,
    });
  }

  // Reconciliación por ausencia: exclusivo de scans completed CON cobertura
  // completa. findings activos de la fuente no detectados en este scan →
  // resolved. La condición se evalúa sobre el estado persistido ANTES de este
  // finalize, dentro de la MISMA transacción.
  if (input.reconcileAbsence) {
    for (const candidate of input.activeForSource) {
      if (
        candidate.fingerprint !== null &&
        !detectedFingerprints.has(candidate.fingerprint)
      ) {
        toResolveIds.push(candidate.id);
      }
    }
  }

  return { toInsert, toUpdate, toResolveIds, createdCount: toInsert.length };
}