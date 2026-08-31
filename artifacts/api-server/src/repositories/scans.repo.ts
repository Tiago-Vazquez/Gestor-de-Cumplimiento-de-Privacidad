import { count, eq } from "drizzle-orm";
import {
  activityTable,
  db,
  findingsTable,
  scansTable,
  sourcesTable,
  type Scan,
} from "@workspace/db";
import { newId } from "./ids";

export type StartScanResult =
  | { ok: true; scan: Scan; sourceName: string; sourceTables: number }
  | { ok: false; reason: "source_not_found" };

/**
 * Inicia un escaneo de forma atómica: crea el scan en estado `running`,
 * marca `last_scan_at` en la fuente y registra el evento de actividad.
 * Devuelve `source_not_found` si la fuente no existe (el handler responderá
 * 404 sin haber escrito nada).
 */
export async function startScan({ sourceId, startedAt }: { sourceId: string; startedAt: Date }): Promise<StartScanResult> {
  return db.transaction(async (tx) => {
    const [source] = await tx.select().from(sourcesTable).where(eq(sourcesTable.id, sourceId));
    if (!source) return { ok: false, reason: "source_not_found" as const };

    const [scan] = await tx
      .insert(scansTable)
      .values({
        id: newId("scan"),
        sourceId: source.id,
        status: "running",
        startedAt,
        completedAt: null,
        findingsCreated: 0,
      })
      .returning();

    await tx
      .update(sourcesTable)
      .set({ lastScanAt: startedAt, updatedAt: new Date() })
      .where(eq(sourcesTable.id, source.id));

    await tx.insert(activityTable).values({
      id: newId("a"),
      type: "scan",
      title: "Escaneo iniciado",
      description: `${source.name} · analizando ${source.tables} tablas`,
      createdAt: startedAt,
      severity: null,
    });

    return { ok: true, scan, sourceName: source.name, sourceTables: source.tables };
  });
}

/**
 * Completa un escaneo de forma atómica: persiste `completed` con el número
 * de hallazgos de la fuente y registra el evento de actividad. Igual que en
 * el comportamiento demo, la finalización ocurre poco después del arranque;
 * al ser transaccional queda registrado aunque el proceso se detenga antes
 * del timeout.
 */
export async function completeScan({ scanId, completedAt }: { scanId: string; completedAt: Date }): Promise<Scan | null> {
  return db.transaction(async (tx) => {
    const [scan] = await tx.select().from(scansTable).where(eq(scansTable.id, scanId));
    if (!scan) return null;

    const [source] = await tx.select().from(sourcesTable).where(eq(sourcesTable.id, scan.sourceId));
    const [countRow] = await tx
      .select({ total: count() })
      .from(findingsTable)
      .where(eq(findingsTable.sourceId, scan.sourceId));

    const [updated] = await tx
      .update(scansTable)
      .set({
        status: "completed",
        completedAt,
        findingsCreated: countRow?.total ?? 0,
      })
      .where(eq(scansTable.id, scanId))
      .returning();

    if (source) {
      await tx.insert(activityTable).values({
        id: newId("a"),
        type: "scan",
        title: "Escaneo completado",
        description: `${source.name} · ${source.tables} tablas revisadas`,
        createdAt: completedAt,
        severity: null,
      });
    }

    return updated;
  });
}
