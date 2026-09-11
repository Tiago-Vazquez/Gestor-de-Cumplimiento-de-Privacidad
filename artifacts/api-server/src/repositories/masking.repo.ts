import { and, desc, eq, inArray, ne } from "drizzle-orm";
import {
  db,
  findingsTable,
  maskingJobsTable,
  type MaskingJob,
} from "@workspace/db";
import { connectPg, readPage } from "../connectors/postgres";
import { badRequest, notFound } from "../lib/errors";
import { logger } from "../lib/logger";
import {
  deriveMaskerKey,
  maskValue,
  MASKABLE_FIELDS,
  type MaskableField,
} from "../lib/masker";
import {
  MAX_MASKING_DATASET_BYTES,
  MAX_MASKING_RECORDS,
} from "../lib/masking-limits";
import type { Pagination } from "../lib/pagination";
import * as activityRepo from "./activity.repo";
import { newId } from "./ids";
import * as sourcesRepo from "./sources.repo";
import type { SourceConnectionConfig } from "./sources.repo";

// Re-exportados para que tests y rutas usen el MISMO origen de la verdad.
export { MAX_MASKING_DATASET_BYTES, MAX_MASKING_RECORDS };

/**
 * FASE 7.3 / M5.c — Repositorio de masking jobs.
 *
 * Decisiones del diagnóstico aprobado:
 * - SÍNCRONO: `create` ejecuta el job completo y persiste UNA sola vez con el
 *   estado final (`ready` con dataset, o `failed` con código de error). Nunca
 *   hay persistencia parcial: el dataset se valida (límites) ANTES del INSERT.
 * - El dataset vive en `masking_jobs.dataset` (jsonb) y SOLO sale por
 *   `getByIdWithDataset` (usado por el download). `list` y `getById` proyectan
 *   columnas explícitas SIN `dataset` (nunca `SELECT *`).
 * - Los errores son auditables vía `status='failed'` + `error` con códigos
 *   estables, sin credenciales, connectionConfig ni PII original.
 */

/** Columnas operativas del job (SIN dataset) para listado y detalle. */
const jobColumns = {
  id: maskingJobsTable.id,
  sourceId: maskingJobsTable.sourceId,
  fields: maskingJobsTable.fields,
  status: maskingJobsTable.status,
  records: maskingJobsTable.records,
  error: maskingJobsTable.error,
  createdAt: maskingJobsTable.createdAt,
  completedAt: maskingJobsTable.completedAt,
};

export type MaskingJobRow = Pick<MaskingJob, keyof typeof jobColumns>;
export type MaskingDatasetPayload = {
  fields: string[];
  rows: Record<string, string>[];
};
export type MaskingJobWithDataset = MaskingJobRow & {
  dataset: MaskingDatasetPayload | null;
};

/** Error de dominio con código auditable (nunca incluye el error crudo). */
class MaskingFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MaskingFailure";
  }
}

/** Valida y deduplica los campos solicitados contra el catálogo M5.b. */
export function assertMaskableFields(fields: string[]): string[] {
  const unique = [...new Set(fields)];
  if (unique.length === 0) {
    throw badRequest("At least one field is required");
  }
  const unsupported = unique.filter(
    (f) => !(MASKABLE_FIELDS as readonly string[]).includes(f),
  );
  if (unsupported.length > 0) {
    throw badRequest(`Unsupported masking fields: ${unsupported.join(", ")}`);
  }
  return unique;
}

/** Tamaño serializado UTF-8 del dataset (validación del límite ~2 MB). */
export function datasetByteSize(dataset: MaskingDatasetPayload): number {
  return Buffer.byteLength(JSON.stringify(dataset), "utf8");
}

/** Mapea cualquier fallo a un código estable, sin filtrar el error crudo. */
export function classifyMaskingError(err: unknown): string {
  if (err instanceof MaskingFailure) return err.code;
  // Errores de red/conexión al leer la fuente: auditables como
  // `source_unreachable` sin filtrar el mensaje original (puede contener
  // host/credenciales del DSN).
  const message = err instanceof Error ? err.message : "";
  if (
    /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EHOSTUNREACH|getaddrinfo|connection refused|timeout/i.test(
      message,
    )
  ) {
    return "source_unreachable";
  }
  return "masking_failed";
}

/**
 * Columnas sensibles a anonimizar para la fuente, resueltas desde los
 * findings activos (no superseded, no resolved) cuya dataType coincide con
 * los campos solicitados. Agrupadas por tabla (`schema.table`), orden
 * determinista. Sin tabla afectada → dataset vacío (job `ready`, 0 records).
 */
async function resolveSensitiveColumns(
  sourceId: string,
  fields: string[],
): Promise<Map<string, { column: string; type: MaskableField }[]>> {
  const rows = await db
    .select({ location: findingsTable.location, dataType: findingsTable.dataType })
    .from(findingsTable)
    .where(
      and(
        eq(findingsTable.sourceId, sourceId),
        inArray(findingsTable.dataType, fields),
        ne(findingsTable.status, "resolved"),
        eq(findingsTable.superseded, false),
      ),
    );
  const byTable = new Map<string, { column: string; type: MaskableField }[]>();
  for (const row of rows) {
    const parts = row.location.split(".");
    if (parts.length < 3) continue; // location canónico: schema.table.column
    const column = parts[parts.length - 1]!;
    const table = parts.slice(0, -1).join(".");
    const list = byTable.get(table) ?? [];
    if (!list.some((c) => c.column === column)) {
      list.push({ column, type: row.dataType as MaskableField });
    }
    byTable.set(table, list);
  }
  return new Map([...byTable.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Lee de la fuente (paginado con cap), anonimiza con el masker M5.b y
 * construye el dataset completo EN MEMORIA antes de persistir.
 */
async function buildDataset(
  config: SourceConnectionConfig,
  columnsByTable: Map<string, { column: string; type: MaskableField }[]>,
  fields: string[],
  key: string,
): Promise<MaskingDatasetPayload> {
  const conn = await connectPg(config).catch(() => {
    throw new MaskingFailure("source_unreachable");
  });
  const rows: Record<string, string>[] = [];
  try {
    for (const [table, columns] of columnsByTable) {
      const budget = MAX_MASKING_RECORDS - rows.length;
      if (budget <= 0) break;
      const raw = await readPage(conn, table, { limit: budget, offset: 0 }).catch(
        () => {
          throw new MaskingFailure("source_read_failed");
        },
      );
      for (const record of raw) {
        const masked: Record<string, string> = {};
        for (const { column, type } of columns) {
          const value = record[column];
          masked[column] = maskValue(value == null ? "" : String(value), type, key);
        }
        rows.push(masked);
      }
    }
  } finally {
    await conn.close().catch(() => undefined);
  }
  return { fields, rows };
}

/**
 * Ejecuta el job síncronamente y persiste UNA vez con estado final.
 * - 404 si la fuente no existe (sin job: nada que auditar).
 * - 400 si algún campo no pertenece a MASKABLE_FIELDS (sin job).
 * - Fallo operativo (conexión/lectura/tamaño) → job `failed` auditable.
 */
export async function create(input: {
  sourceId: string;
  fields: string[];
  at: Date;
}): Promise<MaskingJob> {
  const fields = assertMaskableFields(input.fields);
  const source = await sourcesRepo.getById(input.sourceId);
  if (!source) {
    throw notFound("Source not found");
  }
  try {
    const config = sourcesRepo.decryptConnectionConfig(source);
    if (!config) {
      throw new MaskingFailure("source_not_configured");
    }
    const columnsByTable = await resolveSensitiveColumns(input.sourceId, fields);
    // Subclave de dominio derivada del secreto maestro (M5.b; nunca se
    // loguea ni abandona el proceso).
    const key = deriveMaskerKey(process.env.SOURCE_ENCRYPTION_KEY ?? "");
    const dataset = await buildDataset(config, columnsByTable, fields, key);
    if (datasetByteSize(dataset) > MAX_MASKING_DATASET_BYTES) {
      throw new MaskingFailure("dataset_too_large");
    }
    const completedAt = new Date();
    const [row] = await db
      .insert(maskingJobsTable)
      .values({
        id: newId("mj"),
        sourceId: input.sourceId,
        fields,
        status: "ready",
        records: dataset.rows.length,
        error: null,
        dataset,
        createdAt: input.at,
        completedAt,
      })
      .returning();
    await activityRepo.create({
      id: newId("act"),
      type: "masking",
      title: "Datos anonimizados",
      description: `${row.records} registros preparados para testing`,
      createdAt: completedAt,
      severity: null,
    });
    return row;
  } catch (err) {
    const code = classifyMaskingError(err);
    // Log sin credenciales, connectionConfig ni PII: solo IDs y código.
    logger.error({ sourceId: input.sourceId, code }, "masking job failed");
    const [failed] = await db
      .insert(maskingJobsTable)
      .values({
        id: newId("mj"),
        sourceId: input.sourceId,
        fields,
        status: "failed",
        records: 0,
        error: code,
        dataset: null,
        createdAt: input.at,
        completedAt: new Date(),
      })
      .returning();
    return failed;
  }
}

/** Listado con columnas explícitas (SIN dataset), newest-first, paginado. */
export async function list(pagination?: Pagination): Promise<MaskingJobRow[]> {
  let query = db
    .select(jobColumns)
    .from(maskingJobsTable)
    .orderBy(desc(maskingJobsTable.createdAt), desc(maskingJobsTable.id))
    .$dynamic();
  if (pagination) {
    query = query.limit(pagination.limit).offset(pagination.offset);
  }
  return query;
}

/** Detalle con columnas explícitas (SIN dataset). */
export async function getById(id: string): Promise<MaskingJobRow | null> {
  const [row] = await db
    .select(jobColumns)
    .from(maskingJobsTable)
    .where(eq(maskingJobsTable.id, id))
    .limit(1);
  return row ?? null;
}

/** Solo para el download: única vía de salida del dataset persistido. */
export async function getByIdWithDataset(
  id: string,
): Promise<MaskingJobWithDataset | null> {
  const [row] = await db
    .select()
    .from(maskingJobsTable)
    .where(eq(maskingJobsTable.id, id))
    .limit(1);
  return row ?? null;
}

