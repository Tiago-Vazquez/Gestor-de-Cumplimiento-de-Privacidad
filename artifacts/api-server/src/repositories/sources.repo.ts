import { and, asc, count, eq } from "drizzle-orm";
import { db, findingsTable, sourcesTable, type Source } from "@workspace/db";
import type { Pagination } from "../lib/pagination";
import { decrypt, encrypt } from "../lib/secret-manager";
import { logger } from "../lib/logger";
import { newId } from "./ids";

export type SourceWithFindingsCount = Source & { findingsCount: number };

/**
 * Configuración de conexión para fuentes externas (FASE 7.0.0).
 * Se almacena cifrada en `sources.connection_config` y solo se descifra
 * cuando el scanner necesita abrir la conexión.
 */
export interface SourceConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  schema?: string;
}

/**
 * Cifra la configuración de conexión antes de persistirla.
 * Fail-closed: si SOURCE_ENCRYPTION_KEY no está configurada, lanza error.
 */
export function encryptConnectionConfig(config: SourceConnectionConfig): string {
  return encrypt(JSON.stringify(config));
}

/**
 * Descifra la configuración de conexión desde su representación almacenada.
 * Retorna null si la fuente no tiene configuración (fuentes legacy).
 */
export function decryptConnectionConfig(source: Source): SourceConnectionConfig | null {
  if (!source.connectionConfig) {
    return null;
  }
  // connectionConfig viene como jsonb (string cifrado)
  const encrypted = typeof source.connectionConfig === "string"
    ? source.connectionConfig
    : String(source.connectionConfig);
  try {
    return JSON.parse(decrypt(encrypted));
  } catch (error) {
    // FASE 7.0.5 (M8): distinguir ausencia de configuración (null limpio arriba)
    // de fallo de descifrado. Se registra con sourceId para diagnóstico, sin
    // campos de configuración, plaintext, ciphertext ni claves.
    logger.warn(
      { sourceId: source.id, err: error },
      "Connection config decryption failed; treated as not scannable",
    );
    return null;
  }
}

/**
 * Determina si una fuente está configurada para scanning.
 */
export function isScannable(source: Source): boolean {
  return source.connectionConfig != null;
}

export interface CreateSourceInput {
  name: string;
  kind: string;
  environment: string;
  connection?: SourceConnectionConfig;
}

export interface UpdateSourceInput {
  name?: string;
  kind?: string;
  environment?: string;
  connection?: SourceConnectionConfig | null;
}

/**
 * Crea una fuente con configuración de conexión cifrada (opcional).
 * La contraseña viaja en el body de la request pero NUNCA se persiste en
 * texto plano: se cifra antes del INSERT.
 */
export async function createSource(input: CreateSourceInput): Promise<Source> {
  const now = new Date();
  const values = {
    id: newId("src"),
    name: input.name,
    kind: input.kind,
    environment: input.environment,
    status: "healthy" as const,
    lastScanAt: null,
    tables: 0,
    records: 0,
    connectionConfig: input.connection
      ? encryptConnectionConfig(input.connection)
      : null,
    createdAt: now,
    updatedAt: now,
  };
  const [row] = await db.insert(sourcesTable).values(values).returning();
  return row;
}

/**
 * Actualiza una fuente. Los campos no proporcionados se conservan.
 * Si `connection` se proporciona, se cifra. Si es `null`, se borra la config.
 * Si es `undefined`, no se toca.
 */
export async function updateSource(
  id: string,
  input: UpdateSourceInput,
): Promise<Source | null> {
  const existing = await getById(id);
  if (!existing) return null;

  const set: Partial<Source> = { updatedAt: new Date() };
  if (input.name !== undefined) set.name = input.name;
  if (input.kind !== undefined) set.kind = input.kind;
  if (input.environment !== undefined) set.environment = input.environment;
  if (input.connection !== undefined) {
    set.connectionConfig = input.connection
      ? encryptConnectionConfig(input.connection)
      : null;
  }

  const [row] = await db
    .update(sourcesTable)
    .set(set)
    .where(eq(sourcesTable.id, id))
    .returning();
  return row ?? null;
}

/**
 * Elimina una fuente. FASE 7.0.5 (opción B): los scans asociados se eliminan
 * automáticamente (ON DELETE CASCADE); los hallazgos sobreviven con
 * `source_id = NULL` como evidencia histórica de cumplimiento (ON DELETE
 * SET NULL), preservando `source_name` para la atribución.
 */
export async function deleteSource(id: string): Promise<boolean> {
  const [row] = await db
    .delete(sourcesTable)
    .where(eq(sourcesTable.id, id))
    .returning({ id: sourcesTable.id });
  return row !== undefined;
}

/**
 * FASE 7.0.5 (M1): detalle de fuente con el número REAL de hallazgos
 * asociados (conteo en SQL vía LEFT JOIN, igual que `list`). Antes el detalle
 * devolvía `findings: 0` hardcodeado.
 */
export async function getByIdWithFindingsCount(id: string): Promise<SourceWithFindingsCount | null> {
  const [row] = await db
    .select({ source: sourcesTable, findingsCount: count(findingsTable.id) })
    .from(sourcesTable)
    .leftJoin(findingsTable, eq(findingsTable.sourceId, sourcesTable.id))
    .where(eq(sourcesTable.id, id))
    .groupBy(sourcesTable.id);
  return row ? { ...row.source, findingsCount: row.findingsCount } : null;
}

/**
 * Fuentes monitoreadas con el número de hallazgos asociados (D3: el contrato
 * expone `findings` como conteo, que no es columna de la tabla).
 * Orden estable: creación y, a igualdad, id.
 * F4 (6.3B.20): paginación aplicada en SQL (LIMIT/OFFSET sobre el GROUP BY).
 */
export async function list(pagination?: Pagination): Promise<SourceWithFindingsCount[]> {
  let query = db
    .select({ source: sourcesTable, findingsCount: count(findingsTable.id) })
    .from(sourcesTable)
    .leftJoin(findingsTable, eq(findingsTable.sourceId, sourcesTable.id))
    .groupBy(sourcesTable.id)
    .orderBy(asc(sourcesTable.createdAt), asc(sourcesTable.id))
    .$dynamic();
  if (pagination) {
    query = query.limit(pagination.limit).offset(pagination.offset);
  }

  const rows = await query;
  return rows.map((row) => ({ ...row.source, findingsCount: row.findingsCount }));
}

export async function getById(id: string): Promise<Source | null> {
  const [row] = await db.select().from(sourcesTable).where(eq(sourcesTable.id, id));
  return row ?? null;
}

/** Actualiza `last_scan_at` tras iniciar un escaneo (operación atómica de una
 * sola sentencia; las transacciones multi-tabla viven en scans.repo). */
export async function touchLastScan({ id, at }: { id: string; at: Date }): Promise<Source | null> {
  const [row] = await db
    .update(sourcesTable)
    .set({ lastScanAt: at, updatedAt: new Date() })
    .where(eq(sourcesTable.id, id))
    .returning();
  return row ?? null;
}
